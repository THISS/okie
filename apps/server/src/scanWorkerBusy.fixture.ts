import { parentPort, workerData } from "node:worker_threads";

// Test-only worker for scanWorker.test: blocks its own thread for `ms`, like a synchronous scan, then replies.
const { ms, fail } = workerData as { ms: number; fail?: string };
const startedAt = Date.now(); const until = startedAt + ms;
while (Date.now() < until) { /* busy */ }
parentPort!.postMessage(fail ? { ok: false, error: fail } : { ok: true, value: { commitSha: "f".repeat(40), busyMs: ms, startedAt, endedAt: Date.now() } });
