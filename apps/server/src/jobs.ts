import { scrubGithubTokens } from "@okie/scan";

export type ScanJobStage =
  | "queued"
  | "scanning"
  | "publishing"
  | "enriching"
  | "complete"
  | "failed";

export type EnrichmentState = "pending" | "running" | "complete" | "skipped" | "failed";

export interface ScanJob {
  id: string;
  slug: string;
  owner: string;
  repo: string;
  ref?: string;
  stage: ScanJobStage;
  createdAt: number;
  updatedAt: number;
  /** True once the deterministic trio is on disk — the atlas URL is live from here. */
  atlasReady: boolean;
  commitSha?: string;
  entityCount?: number;
  relationCount?: number;
  enrichment: { state: EnrichmentState; enrichedContainers?: number; note?: string };
  error?: string;
}

export interface ScanJobRequest {
  owner: string;
  repo: string;
  ref?: string;
  slug: string;
}

export type JobRunner = (
  job: ScanJob,
  update: (patch: Partial<ScanJob>) => void,
) => Promise<void>;

export interface ScanJobQueue {
  /** Enqueues a scan, or returns the already-active job for the same repo@ref. */
  submit(request: ScanJobRequest): { job: ScanJob; deduped: boolean };
  get(id: string): ScanJob | undefined;
  list(): ScanJob[];
  /** Resolves when the queue drains (tests). */
  idle(): Promise<void>;
}

/**
 * In-process FIFO scan queue, one job at a time — a scan is CPU-bound (TypeScript
 * parsing over the whole tree), so concurrency would only trade latency between
 * jobs. Durability is intentionally NOT here: the published trio + manifest on
 * disk are the durable output (re-submitting after a restart is idempotent by
 * scan determinism), and job rows are ephemeral progress reporting.
 */
export function createScanJobQueue(
  runJob: JobRunner,
  now: () => number = () => Date.now(),
): ScanJobQueue {
  const jobs = new Map<string, ScanJob>();
  const pending: ScanJob[] = [];
  let running: ScanJob | undefined;
  let counter = 0;
  let drained: (() => void) | undefined;

  const dedupeKey = (value: { slug: string; ref?: string }): string =>
    `${value.slug}@${value.ref ?? "HEAD"}`;

  const activeByKey = (): Map<string, ScanJob> => {
    const active = new Map<string, ScanJob>();
    for (const job of [running, ...pending]) {
      if (job) active.set(dedupeKey(job), job);
    }
    return active;
  };

  const pump = (): void => {
    if (running) return;
    const next = pending.shift();
    if (!next) {
      drained?.();
      drained = undefined;
      return;
    }
    running = next;
    const update = (patch: Partial<ScanJob>): void => {
      Object.assign(next, patch, { updatedAt: now() });
    };
    update({ stage: "scanning" });
    void runJob(next, update)
      .then(() => {
        if (next.stage !== "failed") update({ stage: "complete" });
      })
      .catch((error: unknown) => {
        const raw = error instanceof Error ? error.message : String(error);
        update({
          stage: "failed",
          error: scrubGithubTokens(raw),
        });
      })
      .finally(() => {
        running = undefined;
        pump();
      });
  };

  return {
    submit(request) {
      const existing = activeByKey().get(dedupeKey(request));
      if (existing) return { job: existing, deduped: true };
      counter += 1;
      const job: ScanJob = {
        id: `job-${counter}-${request.slug}`,
        slug: request.slug,
        owner: request.owner,
        repo: request.repo,
        ...(request.ref ? { ref: request.ref } : {}),
        stage: "queued",
        createdAt: now(),
        updatedAt: now(),
        atlasReady: false,
        enrichment: { state: "pending" },
      };
      jobs.set(job.id, job);
      pending.push(job);
      queueMicrotask(pump);
      return { job, deduped: false };
    },
    get: id => jobs.get(id),
    list: () => [...jobs.values()].sort((left, right) => right.createdAt - left.createdAt),
    idle: () =>
      new Promise(resolve => {
        if (!running && pending.length === 0) resolve();
        else drained = resolve;
      }),
  };
}

/**
 * Fixed-window per-key limiter for the submit endpoint — enough to keep one
 * misbehaving client from monopolizing the single scan worker; not a DDoS story.
 */
export function createSubmitLimiter(
  maxPerWindow = 5,
  windowMs = 10 * 60 * 1000,
  now: () => number = () => Date.now(),
): (key: string) => boolean {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return key => {
    const current = windows.get(key);
    const at = now();
    if (!current || at - current.startedAt >= windowMs) {
      windows.set(key, { startedAt: at, count: 1 });
      return true;
    }
    if (current.count >= maxPerWindow) return false;
    current.count += 1;
    return true;
  };
}
