import { Worker } from "node:worker_threads";
import { scrubGithubTokens } from "@okie/scan";
import {
  askCitationDetail,
  commitMatches,
  MAX_ASK_SIDECAR_BYTES,
  MAX_ASK_SNAPSHOT_BYTES,
  retrieveAskSections,
  type AskCorpusLocation,
  type AskIndexCache,
  type AskSection,
} from "./askRetrieval.js";

/**
 * CLA-304: Ask retrieval runs off the request thread. One persistent worker owns the parsed snapshots
 * and their built indexes (an LRU of 4, evicted before each build so at most 4 are ever alive) and runs
 * `retrieveAskSections`. The request thread only locates a snapshot (stat, no read), admits the request,
 * and posts plain data; it never parses a snapshot, builds an index or ranks the atlas.
 *
 * Admission (cheap, synchronous, before any worker work):
 * - at most ASK_WORKER_MAX_PENDING requests wait on the worker; more are refused (HTTP 429 "busy");
 * - a request whose snapshot is neither warm (per the mirror of the worker's cache) nor already being
 *   built needs a cold build, and is admitted only while fewer than ASK_WORKER_MAX_COLD_BUILDS distinct
 *   keys are under build by admitted tickets. Its cold keys are sent as `buildKeys`. A request for a key
 *   another admitted ticket is building joins it and carries that key as `joinKeys`, so it can still
 *   build it if the builder's ticket is released without running (or runs after it). The worker runs
 *   requests in order, so whichever arrives first builds and the rest hit the cache (single flight);
 *   a joined key whose build already failed in this worker is not rebuilt. The worker builds ONLY
 *   authorised keys: any other cache miss (evicted since admission) is skipped, so a warm later
 *   candidate is still searched, and a request with nothing else to search answers "not warm" and
 *   degrades like any retrieval failure. Every buildable key is in the `building` map until all its
 *   tickets settle, so the keys the worker may build never exceed the cap, whatever the mirror says.
 *   Alternating more than 4 slugs therefore costs at most one build at a time; beyond that Ask answers
 *   429 or scope-only;
 * - a key whose build failed (unreadable, corrupt) or whose build was in progress when the deadline hit
 *   or the worker died is negatively cached for ASK_FAILED_KEY_TTL_MS. The worker brackets each build
 *   with `{ type: "building" }` and `{ type: "built" }`, so only a build actually in progress is blamed:
 *   a slow retrieval on a warm index, or after its build finished, never poisons its key.
 *
 * Deadlines: each request gets ASK_RETRIEVAL_TIMEOUT_MS of worker time, or ASK_RETRIEVAL_COLD_TIMEOUT_MS
 * when it is authorised to build (its clock starts when the worker reaches it). On a deadline, or if the
 * worker dies (e.g. its heap cap), the worker is terminated, every request waiting on it fails (Ask
 * degrades exactly like any retrieval failure: scope-only with packets), and the next request respawns
 * it. The warm index cache is lost with the worker.
 */

export const ASK_RETRIEVAL_TIMEOUT_MS = 5_000;
/** Cold build budget: a 71 MB snapshot parses and indexes in 2.5-3.7 s in the worker on a dev laptop (5x+ margin). */
export const ASK_RETRIEVAL_COLD_TIMEOUT_MS = 20_000;
export const ASK_WORKER_MAX_PENDING = 8;
export const ASK_WORKER_MAX_COLD_BUILDS = 1;
/**
 * Worker heap cap: a pathological snapshot kills only the worker. Measured: four warm indexes of a 71 MB
 * (above the 64 MB cap) Ask-eval-shaped snapshot hold ~0.9 GB and all four build and serve under 1,536 MB.
 */
export const ASK_WORKER_HEAP_MB = 1_536;
/** Default warm indexes the worker keeps (each a parsed snapshot plus its search index). */
export const ASK_WORKER_MAX_INDEXES = 4;

/**
 * CLA-266 container sizing: `OKIE_ASK_WORKER_MAX_HEAP_MB` (worker old-generation cap, default ASK_WORKER_HEAP_MB) and
 * `OKIE_ASK_MAX_WARM_INDEXES` (default ASK_WORKER_MAX_INDEXES). Invalid or non-positive values keep the defaults.
 */
export function resolveAskWorkerEnv(env: NodeJS.Dict<string> = process.env): Pick<AskRetrievalWorkerOptions, "heapMb" | "maxIndexes"> {
  const positive = (raw: string | undefined): number | undefined => {
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  };
  const heapMb = positive(env.OKIE_ASK_WORKER_MAX_HEAP_MB);
  const maxIndexes = positive(env.OKIE_ASK_MAX_WARM_INDEXES);
  return { ...(heapMb !== undefined ? { heapMb } : {}), ...(maxIndexes !== undefined ? { maxIndexes } : {}) };
}
export const ASK_FAILED_KEY_TTL_MS = 10 * 60 * 1000;
export const ASK_BUSY_ERROR = "Ask is busy; try again shortly.";

export interface AskWorkerCitationDetail { id: string; name: string; kind: string; path?: string; startLine?: number; endLine?: number }

export interface AskWorkerQuery {
  question: string;
  selectedIds: readonly string[];
  byteBudget: number;
  systemNames?: readonly string[];
}

export interface AskWorkerRequest extends AskWorkerQuery {
  id: number;
  commitSha: string;
  candidates: ReadonlyArray<Pick<AskCorpusLocation, "key" | "source" | "snapshotPath" | "sidecarPath">>;
  /** Keys this request was admitted to build. */
  buildKeys: readonly string[];
  /** Keys another admitted request is building; built here only if still missing and not already failed in this worker. */
  joinKeys?: readonly string[];
}

/** Posted by the worker just before it builds `key` for request `id`. */
export interface AskWorkerBuilding { type: "building"; id: number; key: string }
/** Posted by the worker as soon as that build finished (`ok`) or failed. */
export interface AskWorkerBuilt { type: "built"; id: number; key: string; ok: boolean }

/** Worker-side hooks and state for `handleAskWorkerRequest`. */
export interface AskWorkerHooks {
  onBuilding?: (key: string) => void;
  onBuilt?: (key: string, ok: boolean) => void;
  /** Keys whose build failed in this worker's lifetime; a joined key in it is not rebuilt. */
  failedBuilds?: Set<string>;
}

export const ASK_NOT_WARM_ERROR = "Ask index not warm";

/** What the worker hands back for a matching snapshot: plain, structured-clone data only. */
export interface AskWorkerEvidence {
  source: "publication" | "scan";
  sections: AskSection[];
  bytes: number;
  matchedTerms: string[];
  systemOnly: boolean;
  containerNames: string[];
  entityCount: number;
  /** Index details for every section symbol and every selected id the index knows. */
  citationDetails: AskWorkerCitationDetail[];
}

export interface AskWorkerReply {
  type: "reply";
  id: number;
  ok: boolean;
  /** Absent with `ok` when no candidate matched the atlas commit. */
  evidence?: AskWorkerEvidence;
  error?: string;
  failedKeys: string[];
  builtKeys: string[];
  cachedKeys: string[];
}

export interface AskWorkerSettings { maxIndexes?: number; maxSnapshotBytes?: number; maxSidecarBytes?: number }

const scrub = (error: unknown) => scrubGithubTokens(error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The worker's request handler (synchronous; also driven in-process by tests). */
export function handleAskWorkerRequest(cache: AskIndexCache, request: AskWorkerRequest, hooks: AskWorkerHooks = {}): AskWorkerReply {
  const failedKeys: string[] = [];
  const builtKeys: string[] = [];
  let skipped = false;
  const reply = (rest: Pick<AskWorkerReply, "ok"> & Partial<AskWorkerReply>): AskWorkerReply => ({ type: "reply", id: request.id, failedKeys, builtKeys, cachedKeys: cache.keys(), ...rest });
  const mayBuild = (key: string) => request.buildKeys.includes(key) || (Boolean(request.joinKeys?.includes(key)) && !hooks.failedBuilds?.has(key));
  try {
    for (const candidate of request.candidates) {
      // Never build a key the coordinator did not admit for building; a later warm candidate is still tried.
      if (!cache.has(candidate.key) && !mayBuild(candidate.key)) { skipped = true; continue; }
      let loaded;
      let announced = false;
      try {
        loaded = cache.load(candidate, () => { announced = true; hooks.onBuilding?.(candidate.key); });
      } catch {
        failedKeys.push(candidate.key);
        hooks.failedBuilds?.add(candidate.key);
        // Bounded like the coordinator's negative cache: oldest failures are forgotten first.
        while ((hooks.failedBuilds?.size ?? 0) > 256) hooks.failedBuilds!.delete(hooks.failedBuilds!.values().next().value!);
        if (announced) hooks.onBuilt?.(candidate.key, false);
        continue;
      }
      if (announced) hooks.onBuilt?.(candidate.key, true);
      if (loaded.built) { builtKeys.push(candidate.key); hooks.failedBuilds?.delete(candidate.key); }
      const index = loaded.index;
      if (!commitMatches(index.commitSha, request.commitSha)) continue;
      const retrieval = retrieveAskSections(index, request.question, {
        selectedIds: request.selectedIds,
        byteBudget: request.byteBudget,
        ...(request.systemNames ? { systemNames: request.systemNames } : {}),
      });
      const detailIds = new Set([...retrieval.sections.flatMap(section => (section.symbols ?? []).map(symbol => symbol.id)), ...request.selectedIds]);
      const citationDetails = [...detailIds].map(id => askCitationDetail(index, id)).filter((detail): detail is AskWorkerCitationDetail => Boolean(detail));
      return reply({
        ok: true,
        evidence: {
          source: candidate.source,
          sections: retrieval.sections,
          bytes: retrieval.bytes,
          matchedTerms: retrieval.matchedTerms,
          systemOnly: retrieval.systemOnly,
          containerNames: index.containerNames,
          entityCount: index.documents.length,
          citationDetails,
        },
      });
    }
    return skipped ? reply({ ok: false, error: ASK_NOT_WARM_ERROR }) : reply({ ok: true });
  } catch (error) {
    return reply({ ok: false, error: scrub(error) });
  }
}

export interface AskRetrievalTicket {
  /** Runs the admitted retrieval on the worker; resolves `undefined` when no snapshot matched the commit. Rejects on failure. */
  run(query: AskWorkerQuery): Promise<AskWorkerEvidence | undefined>;
  /** Frees an admitted slot that was never run (no-op after `run`). */
  release(): void;
}

export interface AskRetrievalWorker {
  /** `undefined`: nothing to search (no location, or every one failed recently). `"busy"`: refuse with 429. */
  admit(locations: readonly AskCorpusLocation[], commitSha: string): AskRetrievalTicket | "busy" | undefined;
  stats(): { indexBuilds: number; spawns: number; timeouts: number; crashes: number; pending: number; warmKeys: string[]; failedKeys: string[] };
  close(): Promise<void>;
}

export interface AskRetrievalWorkerOptions extends AskWorkerSettings {
  /** Worker entry (test seam); default `askWorkerMain.js`. */
  workerUrl?: URL;
  timeoutMs?: number;
  coldTimeoutMs?: number;
  maxPending?: number;
  maxColdBuilds?: number;
  heapMb?: number;
  failedKeyTtlMs?: number;
  now?: () => number;
}

interface Job {
  request: AskWorkerRequest;
  resolve: (value: AskWorkerEvidence | undefined) => void;
  reject: (error: Error) => void;
  /** The key the worker announced it is building for this job (cleared when that build finishes). */
  buildingKey?: string;
}

export function createAskRetrievalWorker(options: AskRetrievalWorkerOptions = {}): AskRetrievalWorker {
  const workerUrl = options.workerUrl ?? new URL("./askWorkerMain.js", import.meta.url);
  const timeoutMs = options.timeoutMs ?? ASK_RETRIEVAL_TIMEOUT_MS;
  const coldTimeoutMs = options.coldTimeoutMs ?? ASK_RETRIEVAL_COLD_TIMEOUT_MS;
  const maxPending = options.maxPending ?? ASK_WORKER_MAX_PENDING;
  const maxColdBuilds = options.maxColdBuilds ?? ASK_WORKER_MAX_COLD_BUILDS;
  const failedKeyTtlMs = options.failedKeyTtlMs ?? ASK_FAILED_KEY_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const settings: Required<AskWorkerSettings> = {
    maxIndexes: options.maxIndexes ?? ASK_WORKER_MAX_INDEXES,
    maxSnapshotBytes: options.maxSnapshotBytes ?? MAX_ASK_SNAPSHOT_BYTES,
    maxSidecarBytes: options.maxSidecarBytes ?? MAX_ASK_SIDECAR_BYTES,
  };

  let worker: Worker | undefined;
  let nextId = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const jobs: Job[] = [];
  /** Mirror of the worker's cache after its last reply (exact whenever the worker starts a job). */
  let warm = new Set<string>();
  /** Keys admitted tickets may build (cold or joined): key → unsettled tickets carrying it. */
  const building = new Map<string, number>();
  let reserved = 0;
  const failed = new Map<string, number>();
  const counters = { indexBuilds: 0, spawns: 0, timeouts: 0, crashes: 0 };

  const isFailed = (key: string): boolean => {
    const until = failed.get(key);
    if (until === undefined) return false;
    if (until > now()) return true;
    failed.delete(key);
    return false;
  };
  const markFailed = (keys: readonly string[]) => {
    for (const key of keys) { failed.delete(key); failed.set(key, now() + failedKeyTtlMs); }
    while (failed.size > 256) failed.delete(failed.keys().next().value!);
  };

  const startHead = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const head = jobs[0];
    if (!head) { worker?.unref(); return; }
    // The mirror is exact here (every earlier job has replied): the cold budget applies only when this job may build.
    const mayBuild = [...head.request.buildKeys, ...(head.request.joinKeys ?? [])].some(key => !warm.has(key));
    timer = setTimeout(() => {
      counters.timeouts += 1;
      fail("Ask retrieval timed out");
    }, mayBuild ? coldTimeoutMs : timeoutMs);
  };

  /** Terminates the worker and fails every waiting job; the next request respawns it. */
  const fail = (reason: string) => {
    const current = worker;
    worker = undefined;
    if (timer) { clearTimeout(timer); timer = undefined; }
    // Only a build that was actually in progress is blamed; a slow retrieval on a warm index is not.
    const blamed = jobs[0]?.buildingKey;
    if (blamed) markFailed([blamed]);
    warm = new Set();
    for (const job of jobs.splice(0)) job.reject(new Error(reason));
    if (current) void current.terminate().catch(() => undefined);
  };

  const spawn = (): Worker => {
    const created = new Worker(workerUrl, {
      workerData: settings,
      resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? ASK_WORKER_HEAP_MB },
    });
    counters.spawns += 1;
    created.on("message", (reply: AskWorkerReply | AskWorkerBuilding | AskWorkerBuilt) => {
      if (created !== worker) return;
      const job = jobs[0];
      if (!job || !reply || reply.id !== job.request.id) { counters.crashes += 1; fail("Ask retrieval worker protocol error"); return; }
      if (reply.type === "building") { job.buildingKey = reply.key; return; }
      if (reply.type === "built") {
        if (job.buildingKey === reply.key) delete job.buildingKey;
        if (!reply.ok) markFailed([reply.key]);
        return;
      }
      jobs.shift();
      warm = new Set(reply.cachedKeys);
      counters.indexBuilds += reply.builtKeys.length;
      markFailed(reply.failedKeys);
      if (reply.ok) job.resolve(reply.evidence); else job.reject(new Error(reply.error ?? "Ask retrieval failed"));
      startHead();
    });
    const died = (reason: string) => { if (created !== worker) return; counters.crashes += 1; fail(reason); };
    created.on("error", error => died(scrub(error)));
    created.on("messageerror", () => died("Ask retrieval worker message error"));
    created.on("exit", code => died(`Ask retrieval worker exited with code ${code}`));
    return created;
  };

  const enqueue = (request: AskWorkerRequest): Promise<AskWorkerEvidence | undefined> => new Promise((resolve, reject) => {
    if (!worker) worker = spawn();
    worker.postMessage(request);
    worker.ref();
    jobs.push({ request, resolve, reject });
    if (jobs.length === 1) startHead();
  });

  return {
    admit(locations, commitSha) {
      const candidates = locations.filter(location => !isFailed(location.key)).map(({ key, source, snapshotPath, sidecarPath }) => ({ key, source, snapshotPath, ...(sidecarPath ? { sidecarPath } : {}) }));
      if (!candidates.length) return undefined;
      if (jobs.length + reserved >= maxPending) return "busy";
      const keys = candidates.map(candidate => candidate.key).filter(key => !warm.has(key));
      const cold = keys.filter(key => !building.has(key));
      const joined = keys.filter(key => building.has(key));
      // The cap counts distinct keys under build by any admitted ticket (builders and joiners alike).
      if (cold.length && building.size >= maxColdBuilds) return "busy";
      reserved += 1;
      for (const key of keys) building.set(key, (building.get(key) ?? 0) + 1);
      let state: "admitted" | "running" | "done" = "admitted";
      const settle = () => {
        if (state === "done") return;
        if (state === "admitted") reserved -= 1;
        state = "done";
        for (const key of keys) { const count = (building.get(key) ?? 1) - 1; if (count > 0) building.set(key, count); else building.delete(key); }
      };
      return {
        run(query) {
          if (state !== "admitted") return Promise.reject(new Error("Ask retrieval ticket already used"));
          state = "running";
          reserved -= 1;
          const request: AskWorkerRequest = {
            id: nextId++,
            commitSha,
            candidates,
            buildKeys: cold,
            ...(joined.length ? { joinKeys: joined } : {}),
            question: query.question,
            selectedIds: [...query.selectedIds],
            byteBudget: query.byteBudget,
            ...(query.systemNames ? { systemNames: [...query.systemNames] } : {}),
          };
          let work: Promise<AskWorkerEvidence | undefined>;
          try { work = enqueue(request); } catch (error) { settle(); return Promise.reject(new Error(scrub(error))); }
          return work.finally(settle);
        },
        release() { if (state === "admitted") settle(); },
      };
    },
    stats: () => ({ ...counters, pending: jobs.length + reserved, warmKeys: [...warm], failedKeys: [...failed.keys()].filter(key => isFailed(key)) }),
    async close() {
      const current = worker;
      fail("Ask retrieval worker closed");
      if (current) await current.terminate().catch(() => undefined);
    },
  };
}
