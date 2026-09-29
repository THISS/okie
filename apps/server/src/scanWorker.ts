import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseChildEnv, createScanScratch, hostRustupHome, preparePrivateDir, scanWorkDir, scrubGithubTokens, type GithubSourceRef, type ScanArtifacts, type ScanScratch } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";

/**
 * CLA-271 / CLA-305: repository scans run in a separate PROCESS, off the server's event loop and away from its secrets.
 * `scanGithubRepository` is mostly synchronous CPU work (TypeScript analysis, `spawnSync` rust-analyzer), so running it
 * inline would block every request, webhooks included, for the length of the scan.
 *
 * The child is `node <entry>` started with a minimal environment (see {@link scanChildProcessEnv}): no server secret,
 * API key or GitHub token is in it. The input, including the run's GitHub access token, travels over the IPC channel,
 * never the environment. The child builds its own GitHub client and returns the artifacts by structured clone
 * (`serialization: "advanced"`).
 *
 * Limits: `--max-old-space-size` (OKIE_SCAN_MAX_OLD_SPACE_MB, default 4096), a wall-clock timeout that SIGKILLs the
 * child's whole process group, rust-analyzer included (OKIE_SCAN_TIMEOUT_MS, default 30 min), and on POSIX `ulimit` set
 * by `/bin/sh` before it execs node: no core dumps, CPU seconds (OKIE_SCAN_CPU_SECONDS, default 3600) and maximum file
 * size (OKIE_SCAN_MAX_FILE_MB, default 4096). Address-space limits (`ulimit -v`) are not set: macOS does not support
 * them, and V8 reserves far more virtual memory than it uses, so they break node on Linux too.
 *
 * `--max-old-space-size` caps node only: rust-analyzer's memory is not capped (it is bounded only by its own 120 s
 * timeout and the CPU ulimit).
 *
 * Every scan gets its own private work dir under the scanner work root (`workRoot` option, default `scanWorkDir()` from
 * @okie/scan: OKIE_SCAN_WORK_DIR, else a safe os.tmpdir(), else ~/.cache/okie/scan-work). The child's TMPDIR, OKIE_SCAN_WORK_DIR and HOME point
 * into it, so the extracted tree and all scratch live there, and the PARENT removes it when the child exits, however it
 * ended (reply, timeout, cancellation, crash). On server exit / SIGINT / SIGTERM, live scan process groups are killed
 * and their work dirs removed ({@link killScanChildren}); if the server itself is SIGKILLed or crashes hard, a child
 * busy in synchronous analysis runs on until it next yields (then exits on the IPC disconnect) and its work dir leaks.
 *
 * At most OKIE_SCAN_WORKER_CONCURRENCY (default 1) scans run at once per process; the rest wait in FIFO order. An
 * AbortSignal kills a running scan (the operator runner aborts when the run is cancelled).
 */
export interface WorkerScanInput { source: GithubSourceRef; access: ScanGithubAccess; options: { analysisMode: "full"; codeSurface: "all"; rustIndexCacheDir?: string } }
export interface WorkerScanResult { commitSha: string; artifacts: ScanArtifacts }
type WorkerReply<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ScanChildLimits { maxOldSpaceMb: number; timeoutMs: number; cpuSeconds: number; maxFileMb: number }

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}
export function scanChildLimits(env: NodeJS.ProcessEnv = process.env): ScanChildLimits {
  return {
    maxOldSpaceMb: positive(env.OKIE_SCAN_MAX_OLD_SPACE_MB, 4096),
    timeoutMs: positive(env.OKIE_SCAN_TIMEOUT_MS, 30 * 60 * 1000),
    cpuSeconds: positive(env.OKIE_SCAN_CPU_SECONDS, 3600),
    maxFileMb: positive(env.OKIE_SCAN_MAX_FILE_MB, 4096),
  };
}

/** Scanner configuration the child needs; none of these is a secret. */
const CHILD_PASSTHROUGH = ["OKIE_SCIP_CACHE_MAX_MB", "OKIE_SCAN_RUST_TOOLCHAIN", "OKIE_SCAN_CARGO_HOME", "RUSTUP_TOOLCHAIN", "NODE_EXTRA_CA_CERTS"] as const;

/**
 * The scan child's environment: PATH (absolute entries only), locale, its private work dir as TMPDIR and
 * OKIE_SCAN_WORK_DIR, a scratch HOME inside it, the host's
 * RUSTUP_HOME (resolved here, since HOME is scratch) and the non-secret scanner settings above. Nothing else.
 */
export function scanChildProcessEnv(scratch: Pick<ScanScratch, "dir" | "home">, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { ...baseChildEnv(source), HOME: scratch.home, TMPDIR: scratch.dir, OKIE_SCAN_WORK_DIR: scratch.dir, RUSTUP_HOME: hostRustupHome(source) };
  for (const name of CHILD_PASSTHROUGH) if (source[name]) env[name] = source[name]!;
  return env;
}

export interface RunInWorkerOptions { signal?: AbortSignal; limits?: Partial<ScanChildLimits>; /** Private root for per-scan work dirs (created 0700). */ workRoot?: string }

/** Live scan children: killed (whole process group) and their work dirs removed on server exit. */
const liveChildren = new Map<number, { posix: boolean; scratch: ScanScratch }>();
export function killScanChildren(): void {
  for (const [pid, child] of liveChildren) {
    try { process.kill(child.posix ? -pid : pid, "SIGKILL"); } catch { /* already gone */ }
    try { child.scratch.dispose(); } catch { /* best effort */ }
  }
  liveChildren.clear();
}
process.once("exit", killScanChildren);

/** Runs `moduleUrl` in a child node process, sends it `data` over IPC and settles on its first reply. */
export function runInWorker<T>(moduleUrl: URL, data: unknown, options: RunInWorkerOptions = {}): Promise<T> {
  const limits = { ...scanChildLimits(), ...options.limits };
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("scan cancelled")); return; }
    const entry = fileURLToPath(moduleUrl);
    let scratch: ScanScratch;
    try {
      const parent = options.workRoot ?? scanWorkDir();
      if (options.workRoot) preparePrivateDir(parent);
      scratch = createScanScratch("okie-scan-child-", parent);
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
    const nodeArgs = [`--max-old-space-size=${limits.maxOldSpaceMb}`, entry];
    const posix = process.platform !== "win32" && existsSync("/bin/sh");
    // POSIX: the shell sets the limits (inherited by rust-analyzer too) and execs node, keeping the IPC fd and env.
    const [command, args] = posix
      ? ["/bin/sh", ["-c", 'ulimit -c 0 2>/dev/null; ulimit -t "$1" 2>/dev/null; ulimit -f "$2" 2>/dev/null; shift 2; exec "$@"', "okie-scan", String(limits.cpuSeconds), String(limits.maxFileMb * 2048), process.execPath, ...nodeArgs]] as const
      : [process.execPath, nodeArgs] as const;
    const child = spawn(command, [...args], { env: scanChildProcessEnv(scratch), stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", detached: posix, windowsHide: true });
    if (child.pid) liveChildren.set(child.pid, { posix, scratch });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    let settled = false; let exited = false;
    const kill = () => {
      if (exited) return;
      // The whole process group: node and any rust-analyzer it is waiting on.
      try { if (posix && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const onAbort = () => settle(() => reject(new Error("scan cancelled")));
    const timer = setTimeout(() => settle(() => reject(new Error(`scan exceeded its ${limits.timeoutMs} ms time limit and was killed`))), limits.timeoutMs);
    timer.unref?.();
    const settle = (action: () => void) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      action(); kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", (reply: WorkerReply<T>) => settle(() => reply.ok ? resolve(reply.value) : reject(new Error(scrubGithubTokens(reply.error)))));
    child.once("error", error => { if (!child.pid) scratch.dispose(); settle(() => reject(new Error(scrubGithubTokens(error.message)))); });
    child.once("exit", (code, signal) => {
      exited = true; if (child.pid) liveChildren.delete(child.pid);
      // Reap anything the child left in its process group (an orphaned rust-analyzer), then remove the work dir the
      // parent owns, whatever ended the child (reply, timeout, cancel, crash). Neither may throw into the server.
      if (posix && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already empty */ } }
      try { scratch.dispose(); } catch { /* best effort; the work root is private */ }
      const detail = stderr.trim().split("\n").slice(-5).join("\n");
      settle(() => reject(new Error(scrubGithubTokens(`scan process exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`))));
    });
    // The token rides on IPC, never argv or the environment.
    child.send(data as never, error => { if (error) settle(() => reject(new Error(scrubGithubTokens(error.message)))); });
  });
}

/** OKIE_SCAN_WORKER_CONCURRENCY: concurrent scans per process (default 1). */
export function scanWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.OKIE_SCAN_WORKER_CONCURRENCY ?? "", 10);
  return Number.isFinite(value) && value >= 1 ? value : 1;
}
let active = 0; const waiting: Array<() => void> = [];
/** A freed slot passes straight to the next waiter, so the limit holds even while that waiter resumes. */
async function acquire(limit: number): Promise<void> { if (active < limit) { active += 1; return; } await new Promise<void>(resolve => waiting.push(resolve)); }
function release(): void { const next = waiting.shift(); if (next) next(); else active -= 1; }
/** runInWorker under the process-wide scan limit. */
export async function runLimitedWorker<T>(moduleUrl: URL, data: unknown, options: RunInWorkerOptions = {}): Promise<T> {
  await acquire(scanWorkerConcurrency());
  try { return await runInWorker<T>(moduleUrl, data, options); } finally { release(); }
}

export function scanInWorker(input: WorkerScanInput, options: RunInWorkerOptions = {}): Promise<WorkerScanResult> {
  return runLimitedWorker<WorkerScanResult>(new URL("./scanWorkerMain.js", import.meta.url), input, options);
}
