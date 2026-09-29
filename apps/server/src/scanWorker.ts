import { Worker } from "node:worker_threads";
import { scrubGithubTokens, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";

/**
 * CLA-271: repository scans run off the event loop. `scanGithubRepository` is mostly synchronous CPU work (TypeScript
 * analysis, `spawnSync` rust-analyzer), so running it inline blocks every request, webhooks included, for the length of
 * the scan. The operator runner's default scan posts plain data (source, access, options) to a worker thread, which
 * builds its own GitHub client and returns the artifacts by structured clone. At most OKIE_SCAN_WORKER_CONCURRENCY
 * (default 1) scans run at once per process; the rest wait in FIFO order. Known limitation: cancelling a run does not
 * stop its worker; the scan finishes and the runner discards the result.
 */
export interface WorkerScanInput { source: GithubSourceRef; access: ScanGithubAccess; options: { analysisMode: "full"; codeSurface: "all"; rustIndexCacheDir?: string } }
export interface WorkerScanResult { commitSha: string; artifacts: ScanArtifacts }
type WorkerReply<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs `moduleUrl` in a worker with `data` as its workerData; settles on its first message, then terminates it. */
export function runInWorker<T>(moduleUrl: URL, data: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(moduleUrl, { workerData: data });
    let settled = false;
    const settle = (action: () => void) => { if (settled) return; settled = true; action(); void worker.terminate(); };
    worker.once("message", (reply: WorkerReply<T>) => settle(() => reply.ok ? resolve(reply.value) : reject(new Error(reply.error))));
    worker.once("error", error => settle(() => reject(new Error(scrubGithubTokens(error instanceof Error ? error.message : String(error))))));
    worker.once("exit", code => settle(() => reject(new Error(`scan worker exited with code ${code}`))));
  });
}

/** OKIE_SCAN_WORKER_CONCURRENCY: concurrent worker scans per process (default 1). */
export function scanWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.OKIE_SCAN_WORKER_CONCURRENCY ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? value : 1;
}
let active = 0; const waiting: Array<() => void> = [];
/** A freed slot passes straight to the next waiter, so the limit holds even while that waiter resumes. */
async function acquire(limit: number): Promise<void> { if (active < limit) { active += 1; return; } await new Promise<void>(resolve => waiting.push(resolve)); }
function release(): void { const next = waiting.shift(); if (next) next(); else active -= 1; }
/** runInWorker under the process-wide worker-scan limit. */
export async function runLimitedWorker<T>(moduleUrl: URL, data: unknown): Promise<T> {
  await acquire(scanWorkerConcurrency());
  try { return await runInWorker<T>(moduleUrl, data); } finally { release(); }
}

export function scanInWorker(input: WorkerScanInput): Promise<WorkerScanResult> {
  return runLimitedWorker<WorkerScanResult>(new URL("./scanWorkerMain.js", import.meta.url), input);
}
