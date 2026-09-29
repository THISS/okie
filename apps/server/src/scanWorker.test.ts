import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killScanChildren, runInWorker, runLimitedWorker, scanChildLimits, scanWorkerConcurrency } from "./scanWorker.js";

test("scan worker: a scan that blocks its thread never blocks the server's event loop", async () => {
  const server = createServer((_request, response) => { response.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
  try {
    const started = Date.now();
    // The fixture busy-waits for 1.5 s in the scan child process, like a synchronous TypeScript analysis or spawnSync rust-analyzer.
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

const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-fake-cla305", GITHUB_TOKEN: "ghp_fakecla305fakecla305fakecla305fake", GH_TOKEN: "gho_fakecla305fake",
  OKIE_SESSION_SECRET: "fake-session-secret-cla305", OKIE_GITHUB_CLIENT_SECRET: "fake-oauth-secret-cla305", DATABASE_URL: "postgres://u:fake-dotenv-cla305@h/db",
};
type Report = { pid: number; env: Record<string, string>; heapLimitMb: number; ulimits: string };

test("scan child (CLA-305): a separate process whose env carries no server secret, with a heap cap and ulimits", async () => {
  const previous = Object.fromEntries(Object.keys(SECRETS).map(name => [name, process.env[name]]));
  Object.assign(process.env, SECRETS);
  try {
    const report = await runInWorker<Report>(BUSY, { ms: 10, report: true, token: "ghs_viaipcfakecla305" }, { limits: { maxOldSpaceMb: 256, cpuSeconds: 120, maxFileMb: 8 } });
    assert.notEqual(report.pid, process.pid, "a separate process, not a thread");
    for (const [name, value] of Object.entries(report.env)) {
      assert.ok(!Object.values(SECRETS).some(secret => value.includes(secret)) && !value.includes("ghs_viaipcfakecla305"), `${name} carries a secret`);
    }
    for (const name of Object.keys(SECRETS)) assert.equal(report.env[name], undefined, name);
    assert.notEqual(report.env.HOME, process.env.HOME, "HOME is scratch");
    assert.ok(report.heapLimitMb <= 400, `heap limit ${report.heapLimitMb} MB follows --max-old-space-size`);
    if (process.platform !== "win32") assert.equal(report.ulimits, "0 120 16384", "no core dumps, CPU seconds, file size in 512-byte blocks");
  } finally { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test("scan child (CLA-305): the wall-clock limit and cancellation both kill the process", async () => {
  const started = Date.now();
  await assert.rejects(runInWorker(BUSY, { ms: 10_000 }, { limits: { timeoutMs: 400 } }), /time limit and was killed/);
  assert.ok(Date.now() - started < 5000, "killed, not waited out");
  const controller = new AbortController();
  const cancelled = runLimitedWorker(BUSY, { ms: 10_000 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const before = Date.now();
  await assert.rejects(cancelled, /scan cancelled/);
  assert.ok(Date.now() - before < 5000);
  // The slot was freed.
  await runLimitedWorker(BUSY, { ms: 10 });
  assert.deepEqual(scanChildLimits({}), { maxOldSpaceMb: 4096, timeoutMs: 1_800_000, cpuSeconds: 3600, maxFileMb: 4096 });
  assert.equal(scanChildLimits({ OKIE_SCAN_TIMEOUT_MS: "1000", OKIE_SCAN_MAX_OLD_SPACE_MB: "0" }).timeoutMs, 1000);
});

async function until(condition: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
  return condition();
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

type Probe = { pid: number; workDir: string; workFile: string; grandchild: number };
/** Waits (polling) until the busy child has written its probe: its work dir exists and its grandchild runs. */
async function probed(path: string): Promise<Probe> {
  assert.ok(await until(() => existsSync(path), 20_000), "the child started and wrote its probe");
  return JSON.parse(readFileSync(path, "utf8")) as Probe;
}

test("scan child (CLA-305): a killed child leaves no work dir behind, and the group kill reaches its grandchildren", { skip: process.platform === "win32" ? "POSIX process groups" : false }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "okie-scan-child-test-"));
  const workRoot = join(scratch, "work"); const probe = join(scratch, "probe.json");
  try {
    const controller = new AbortController();
    const run = runInWorker(BUSY, { ms: 60_000, probe }, { workRoot, signal: controller.signal });
    const seen = await probed(probe);
    assert.ok(seen.workDir.startsWith(workRoot), `the child's TMPDIR ${seen.workDir} is a per-scan dir under the work root`);
    assert.ok(existsSync(seen.workFile));
    controller.abort();
    await assert.rejects(run, /scan cancelled/);
    assert.ok(await until(() => !existsSync(seen.workDir)), "the parent removed the killed child's work dir");
    assert.deepEqual(readdirSync(workRoot), [], "nothing is left under the work root");
    assert.ok(await until(() => !alive(seen.pid)), "the child is gone");
    assert.ok(await until(() => !alive(seen.grandchild)), `grandchild ${seen.grandchild} was killed with the process group`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("scan child (CLA-305): killScanChildren (server exit / SIGINT / SIGTERM) kills every live scan group and removes its work dir", { skip: process.platform === "win32" ? "POSIX process groups" : false }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "okie-scan-child-exit-"));
  const workRoot = join(scratch, "work"); const probe = join(scratch, "probe.json");
  try {
    const run = runInWorker(BUSY, { ms: 60_000, probe }, { workRoot });
    const settled = run.then(() => "resolved", () => "rejected");
    const seen = await probed(probe);
    killScanChildren();
    assert.ok(await until(() => !alive(seen.pid) && !alive(seen.grandchild)), "child and grandchild are gone");
    assert.ok(await until(() => !existsSync(seen.workDir)), "its work dir was removed");
    assert.equal(await settled, "rejected", "the scan fails rather than hanging");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
