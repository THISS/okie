import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runInWorker, runLimitedWorker, scanWorkerConcurrency } from "./scanWorker.js";

test("scan worker: a scan that blocks its thread never blocks the server's event loop", async () => {
  const server = createServer((_request, response) => { response.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
  try {
    const started = Date.now();
    // The fixture busy-waits for 1.5 s in the worker, like a synchronous TypeScript analysis or spawnSync rust-analyzer.
    const scan = runInWorker<{ commitSha: string; busyMs: number; startedAt?: number; endedAt?: number }>(new URL("./scanWorkerBusy.fixture.js", import.meta.url), { ms: 1500 });
    await new Promise(resolve => setTimeout(resolve, 200));
    const asked = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const answeredMs = Date.now() - asked;
    assert.equal(await response.text(), "ok");
    assert.ok(answeredMs < 500, `the main loop answered in ${answeredMs} ms while the worker was busy`);
    const result = await scan;
    assert.ok(Date.now() - started >= 1500, "the scan really ran for its full duration");
    assert.deepEqual({ commitSha: result.commitSha, busyMs: result.busyMs }, { commitSha: "f".repeat(40), busyMs: 1500 }, "the result comes back by structured clone");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("scan worker: a worker that cannot start rejects instead of hanging", async () => {
  await assert.rejects(runInWorker(new URL("./no-such-scan-worker.js", import.meta.url), {}));
});

const BUSY = new URL("./scanWorkerBusy.fixture.js", import.meta.url);
type Busy = { startedAt: number; endedAt: number };

test("scan worker: OKIE_SCAN_WORKER_CONCURRENCY caps concurrent scans (default 1); the rest queue in order", async () => {
  assert.equal(scanWorkerConcurrency({}), 1); assert.equal(scanWorkerConcurrency({ OKIE_SCAN_WORKER_CONCURRENCY: "3" }), 3); assert.equal(scanWorkerConcurrency({ OKIE_SCAN_WORKER_CONCURRENCY: "0" }), 1);
  const previous = process.env.OKIE_SCAN_WORKER_CONCURRENCY;
  try {
    delete process.env.OKIE_SCAN_WORKER_CONCURRENCY;
    const [a, b, c] = await Promise.all([0, 1, 2].map(() => runLimitedWorker<Busy>(BUSY, { ms: 300 })));
    assert.ok(b!.startedAt >= a!.endedAt && c!.startedAt >= b!.endedAt, "one at a time, in order");
    process.env.OKIE_SCAN_WORKER_CONCURRENCY = "2";
    const [d, e] = await Promise.all([0, 1].map(() => runLimitedWorker<Busy>(BUSY, { ms: 600 })));
    assert.ok(e!.startedAt < d!.endedAt && d!.startedAt < e!.endedAt, "two overlap when allowed");
    // A failed scan frees its slot.
    await assert.rejects(runLimitedWorker(BUSY, { ms: 10, fail: "boom" }), /boom/);
    await runLimitedWorker<Busy>(BUSY, { ms: 10 });
  } finally { if (previous === undefined) delete process.env.OKIE_SCAN_WORKER_CONCURRENCY; else process.env.OKIE_SCAN_WORKER_CONCURRENCY = previous; }
});
