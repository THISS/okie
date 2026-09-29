import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";

// Test-only scan child for scanWorker.test: blocks its own thread for `ms`, like a synchronous scan, then replies.
// `report` adds what the child can see: its environment, heap limit and (POSIX) ulimits. `probe` (a path) makes it
// write a file into its work dir (TMPDIR) and start a grandchild `sleep`, recording both in `probe` before blocking.
process.on("disconnect", () => process.exit(1));
process.once("message", (message: unknown) => {
  const { ms, fail, report, probe } = message as { ms: number; fail?: string; report?: boolean; probe?: string };
  if (probe) {
    const workFile = join(process.env.TMPDIR!, "extracted-tree-stand-in.txt");
    writeFileSync(workFile, "scan scratch\n");
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    writeFileSync(probe, JSON.stringify({ pid: process.pid, workDir: process.env.TMPDIR, workFile, grandchild: sleeper.pid }));
  }
  const startedAt = Date.now(); const until = startedAt + ms;
  while (Date.now() < until) { /* busy */ }
  const extra = report ? {
    env: { ...process.env },
    heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1024 / 1024),
    ulimits: process.platform === "win32" ? "" : spawnSync("/bin/sh", ["-c", "echo $(ulimit -c) $(ulimit -t) $(ulimit -f)"], { encoding: "utf8" }).stdout.trim(),
  } : {};
  process.send!(fail ? { ok: false, error: fail } : { ok: true, value: { commitSha: "f".repeat(40), busyMs: ms, startedAt, endedAt: Date.now(), pid: process.pid, ...extra } }, () => process.exit(0));
});
