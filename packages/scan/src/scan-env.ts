import { execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { inspectWorkRoot, type AncestorFs } from "./rust-ancestors.js";

/**
 * CLA-305: the one place scanner child processes (git, gh, rust-analyzer, rustc, rustup) get their environment.
 *
 * Children never inherit `process.env`. They get an allowlisted environment instead:
 * - PATH: the host PATH minus empty and relative entries, so a repository-relative `.` can't shadow a tool.
 * - LANG and LC_ALL pinned to C.UTF-8, and the host TMPDIR.
 * - A scratch HOME and CARGO_HOME inside a private (0700) mkdtemp dir, so no dotfile, credential or cargo config of the
 *   host user is visible.
 * - CARGO_NET_OFFLINE=true, and git with no system or global config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null)
 *   and no prompts.
 * - The Rust pins from {@link rustToolchainPin}.
 *
 * No API key, `GITHUB_*` / `GH_*` token or `.env` value is ever copied. The one exception is the operator `gh` CLI
 * fallback (github.ts): it needs the operator's own GitHub auth, so it gets GH_TOKEN / GITHUB_TOKEN when set, and the
 * real HOME / GH_CONFIG_DIR, because gh's stored login (hosts.yml, or the macOS keychain looked up via HOME) lives there.
 * gh only downloads; it never executes repository content.
 *
 * See docs/architecture/scan-sandbox.md.
 */
export type ScanChildKind = "git" | "gh" | "rust";

/**
 * The private root every scanner temp dir lives under (tarball extraction, committed-tree copies, rust-analyzer scratch,
 * scratch HOME). rust-analyzer and cargo read config from the ANCESTORS of the analysed tree (rust-ancestors.ts), so the
 * root must sit under directories only root or the scanner's user can write, outside any Cargo workspace. Resolved once
 * per process ({@link chooseScanWorkRoot}); the server's per-scan dirs use it too. The root is always a DEDICATED
 * `okie-scan-work` directory (0700, ours, symlinks resolved) inside the chosen parent, never the parent itself, so an
 * operator's directory is never chmod-ed:
 * 1. `$OKIE_SCAN_WORK_DIR/okie-scan-work` when OKIE_SCAN_WORK_DIR is set (the operator's choice);
 * 2. else `$TMPDIR/okie-scan-work` when os.tmpdir() passes {@link inspectWorkRoot} (the macOS per-user T dir does);
 * 3. else `$XDG_RUNTIME_DIR/okie-scan-work` when set and passing (per-user, and not under ~, so ~/.cargo does not apply);
 * 4. else `${XDG_CACHE_HOME:-~/.cache}/okie/scan-work` when it passes;
 * 5. else os.tmpdir() itself: Rust analysis then refuses to run there, with a limitation.
 * Re-prepared before every use, so a deleted root is recreated.
 */
export function scanWorkDir(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.OKIE_SCAN_WORK_DIR?.trim();
  if (configured && isAbsolute(configured)) return dedicatedDir(configured, "okie-scan-work");
  if (source !== process.env) return chooseScanWorkRoot({ source }).root;
  if (workRootMemo) { try { if (workRootMemo.dedicated) preparePrivateDir(workRootMemo.root); return workRootMemo.root; } catch { workRootMemo = undefined; } }
  const choice = chooseScanWorkRoot();
  workRootMemo = { root: choice.root, dedicated: choice.source !== "tmpdir-unsafe" };
  return choice.root;
}
let workRootMemo: { root: string; dedicated: boolean } | undefined;
export function resetScanWorkDirForTests(): void { workRootMemo = undefined; }

/** `parent/name...` created 0700 as ours, returned with symlinks resolved. */
function dedicatedDir(parent: string, ...names: string[]): string {
  const dir = join(parent, ...names);
  preparePrivateDir(dir);
  return realpathSync(dir);
}

export interface WorkRootChoice { root: string; source: "OKIE_SCAN_WORK_DIR" | "tmpdir" | "xdg-runtime" | "user-cache" | "tmpdir-unsafe"; rejected: string[] }
/** The resolution behind {@link scanWorkDir}, with seams for tests (`prepare` returns the directory to use). */
export function chooseScanWorkRoot(options: { source?: NodeJS.ProcessEnv; tmp?: string; home?: string; fs?: AncestorFs; uid?: number | undefined; prepare?: (parent: string, ...names: string[]) => string } = {}): WorkRootChoice {
  const source = options.source ?? process.env;
  const prepare = options.prepare ?? dedicatedDir;
  const inspect = (dir: string) => inspectWorkRoot(dir, { ...(options.fs ? { fs: options.fs } : {}), ...("uid" in options ? { uid: options.uid } : {}) });
  const configured = source.OKIE_SCAN_WORK_DIR?.trim();
  if (configured && isAbsolute(configured)) return { root: prepare(configured, "okie-scan-work"), source: "OKIE_SCAN_WORK_DIR", rejected: [] };
  const rejected: string[] = [];
  const tmp = options.tmp ?? tmpdir();
  const cacheHome = source.XDG_CACHE_HOME && isAbsolute(source.XDG_CACHE_HOME) ? source.XDG_CACHE_HOME : join(options.home ?? homedir(), ".cache");
  const runtime = source.XDG_RUNTIME_DIR && isAbsolute(source.XDG_RUNTIME_DIR) ? source.XDG_RUNTIME_DIR : undefined;
  const candidates: Array<{ parent: string; names: string[]; source: WorkRootChoice["source"]; create: boolean }> = [
    { parent: tmp, names: ["okie-scan-work"], source: "tmpdir", create: false },
    ...(runtime ? [{ parent: runtime, names: ["okie-scan-work"], source: "xdg-runtime" as const, create: false }] : []),
    { parent: cacheHome, names: ["okie", "scan-work"], source: "user-cache", create: true },
  ];
  for (const candidate of candidates) {
    try {
      // tmpdir / XDG_RUNTIME_DIR must already exist and pass; ~/.cache/okie may be created first, then checked.
      const root = candidate.create ? prepare(candidate.parent, ...candidate.names) : undefined;
      const problem = inspect(root ?? candidate.parent);
      if (problem) { rejected.push(`${candidate.source}: ${problem}`); continue; }
      return { root: root ?? prepare(candidate.parent, ...candidate.names), source: candidate.source, rejected };
    } catch (error) { rejected.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { root: tmp, source: "tmpdir-unsafe", rejected };
}

/**
 * mkdir -p 0700, then insist it is a plain directory owned by this uid (throws otherwise: another user may have
 * pre-created it), and chmod it back to 0700 if it is looser. Only used on the scanner's own dedicated directories.
 */
export function preparePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} is not a plain directory`);
  if (process.platform === "win32") return;
  if (stat.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user (uid ${stat.uid})`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** A private per-scan scratch dir: HOME and CARGO_HOME live inside it. `dispose` removes it. */
export interface ScanScratch { dir: string; home: string; cargoHome: string; dispose(): void }

export function createScanScratch(prefix = "okie-scan-", parent = scanWorkDir()): ScanScratch {
  const dir = mkdtempSync(join(parent, prefix));
  chmodSync(dir, 0o700);
  const home = join(dir, "home"); const cargoHome = join(dir, "cargo-home");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cargoHome, { mode: 0o700 });
  return { dir, home, cargoHome, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

let processScratch: ScanScratch | undefined;
/** Scratch for one-off git/gh calls outside a Rust run; created lazily, removed at process exit. */
function sharedScratch(): ScanScratch {
  if (!processScratch || !existsSync(processScratch.dir)) {
    processScratch = createScanScratch("okie-scan-env-");
    const scratch = processScratch;
    process.once("exit", () => scratch.dispose());
  }
  return processScratch;
}

/** The host PATH without empty or relative entries (`.`, `bin`, `./node_modules/.bin`). */
export function sanitizedPath(path = process.env.PATH ?? ""): string {
  return path.split(delimiter).filter(entry => entry !== "" && isAbsolute(entry)).join(delimiter);
}

const WINDOWS_PASSTHROUGH = ["SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR"];

/** PATH, locale and TMPDIR: the base every child gets (and the scan child process of apps/server). */
export function baseChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: sanitizedPath(source.PATH ?? ""), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  const tmp = source.TMPDIR ?? source.TMP ?? source.TEMP;
  if (tmp && isAbsolute(tmp)) env.TMPDIR = tmp;
  if (process.platform === "win32") for (const name of WINDOWS_PASSTHROUGH) if (source[name]) env[name] = source[name]!;
  return env;
}

/** The rustup home of the host user, resolved from the real environment (a scratch HOME would lose it). */
export function hostRustupHome(source: NodeJS.ProcessEnv = process.env): string {
  return source.RUSTUP_HOME && isAbsolute(source.RUSTUP_HOME) ? source.RUSTUP_HOME : join(homedir(), ".rustup");
}

/**
 * The Rust toolchain every scanner child uses, resolved ONCE per process from the scanner's own working directory (never
 * the scanned repository), so a repository `rust-toolchain(.toml)` can neither select a `path = "..."` toolchain of
 * repository binaries nor trigger a rustup auto-install. OKIE_SCAN_RUST_TOOLCHAIN overrides it. Coverage trade-off: a
 * repository pinned to another channel (say nightly) is analysed with this toolchain.
 *
 * `rustc` / `cargo` are the toolchain's own binaries (from `rustc --print sysroot`), exported as RUSTC /
 * CARGO_BUILD_RUSTC / CARGO so a repository `.cargo/config.toml` `build.rustc` cannot substitute another compiler.
 */
export interface RustToolchainPin { toolchain?: string; rustupHome: string; sysroot?: string; rustc?: string; cargo?: string; rustAnalyzer?: string; error?: string }

let pinMemo: RustToolchainPin | undefined;
export function resetRustToolchainPinForTests(): void { pinMemo = undefined; }

export function rustToolchainPin(source: NodeJS.ProcessEnv = process.env): RustToolchainPin {
  if (pinMemo) return pinMemo;
  const rustupHome = hostRustupHome(source);
  const scratch = sharedScratch();
  const base = { ...baseChildEnv(source), HOME: scratch.home, CARGO_HOME: scratch.cargoHome, RUSTUP_HOME: rustupHome, RUSTUP_AUTO_INSTALL: "0" };
  let toolchain = source.OKIE_SCAN_RUST_TOOLCHAIN?.trim() || undefined;
  if (!toolchain) {
    // The scanner's own cwd (plus any RUSTUP_TOOLCHAIN the operator set) decides, exactly as it did before the pin.
    const inherited = source.RUSTUP_TOOLCHAIN ? { RUSTUP_TOOLCHAIN: source.RUSTUP_TOOLCHAIN } : {};
    const shown = spawnSync("rustup", ["show", "active-toolchain"], { cwd: process.cwd(), env: { ...base, ...inherited }, encoding: "utf8", timeout: 30_000 });
    if ((shown.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      // No rustup: no proxies, so no toolchain file is honoured by anything. Pin the compiler only.
    } else if (shown.status !== 0 || shown.error) {
      return pinMemo = { rustupHome, error: `could not resolve the scanner's Rust toolchain (rustup show active-toolchain): ${(shown.stderr || shown.error?.message || "").trim()}` };
    } else {
      const name = shown.stdout.trim().split(/\s+/)[0];
      if (!name) return pinMemo = { rustupHome, error: "could not resolve the scanner's Rust toolchain: rustup printed no active toolchain" };
      // A path toolchain from a toolchain file around the scanner's cwd is never adopted implicitly.
      if (/[\\/]/.test(name)) return pinMemo = { rustupHome, error: `the scanner's working directory selects a path toolchain (${name}); set OKIE_SCAN_RUST_TOOLCHAIN to a named toolchain` };
      toolchain = name;
    }
  }
  const pinned = { ...base, ...(toolchain ? { RUSTUP_TOOLCHAIN: toolchain } : {}) };
  const sysrootRun = spawnSync("rustc", ["--print", "sysroot"], { cwd: scratch.dir, env: pinned, encoding: "utf8", timeout: 30_000 });
  const sysroot = sysrootRun.status === 0 && !sysrootRun.error ? sysrootRun.stdout.trim() : undefined;
  const binary = (name: string) => {
    if (!sysroot) return undefined;
    const path = join(sysroot, "bin", process.platform === "win32" ? `${name}.exe` : name);
    return existsSync(path) ? path : undefined;
  };
  const rustc = binary("rustc"); const cargo = binary("cargo"); const rustAnalyzer = binary("rust-analyzer");
  return pinMemo = { rustupHome, ...(toolchain ? { toolchain } : {}), ...(sysroot ? { sysroot } : {}), ...(rustc ? { rustc } : {}), ...(cargo ? { cargo } : {}), ...(rustAnalyzer ? { rustAnalyzer } : {}),
    ...(sysroot ? {} : { error: `rustc is unavailable for the scanner's Rust toolchain${toolchain ? ` ${toolchain}` : ""}: ${(sysrootRun.stderr || sysrootRun.error?.message || "").trim()}` }) };
}

/** The Rust pins as environment variables: toolchain, compiler, no wrappers, no auto-install. */
function rustEnv(pin: RustToolchainPin): Record<string, string> {
  const env: Record<string, string> = {
    RUSTUP_HOME: pin.rustupHome, RUSTUP_AUTO_INSTALL: "0",
    // `.cargo/config.toml` build.rustc-wrapper / rustc-workspace-wrapper: cargo metadata runs `rustc -vV` through them.
    RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "", CARGO_BUILD_RUSTC_WRAPPER: "", CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "",
  };
  if (pin.toolchain) env.RUSTUP_TOOLCHAIN = pin.toolchain;
  if (pin.rustc) { env.RUSTC = pin.rustc; env.CARGO_BUILD_RUSTC = pin.rustc; }
  if (pin.cargo) env.CARGO = pin.cargo;
  return env;
}

/**
 * OKIE_SCAN_CARGO_HOME: an operator-trusted CARGO_HOME (ideally a dedicated, registry-only cache the scanner can only
 * read) so offline `cargo metadata` resolves crates.io dependencies. Refused when relative or when it holds cargo
 * credentials (credentials.toml / credentials), e.g. the host ~/.cargo of a user who has run `cargo login`.
 */
export function operatorCargoHome(source: NodeJS.ProcessEnv = process.env): { path?: string; error?: string } {
  const path = source.OKIE_SCAN_CARGO_HOME?.trim();
  if (!path) return {};
  if (!isAbsolute(path)) return { error: `OKIE_SCAN_CARGO_HOME must be an absolute path (got ${path}); using an isolated scratch CARGO_HOME` };
  const credentials = ["credentials.toml", "credentials"].filter(name => existsSync(join(path, name)));
  if (credentials.length) return { error: `OKIE_SCAN_CARGO_HOME (${path}) holds cargo credentials (${credentials.join(", ")}); refused, using an isolated scratch CARGO_HOME` };
  return { path };
}

/**
 * The allowlisted environment for one scanner child. `scratch` defaults to a process-wide private scratch dir;
 * a Rust run passes its own per-run scratch. A valid OKIE_SCAN_CARGO_HOME ({@link operatorCargoHome}) replaces the
 * scratch CARGO_HOME.
 */
export function scanChildEnv(kind: ScanChildKind, scratch: ScanScratch = sharedScratch(), source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = baseChildEnv(source);
  if (kind === "gh") {
    // Operator CLI fallback only: gh's own login is keyed on HOME / GH_CONFIG_DIR; tokens are the documented exception.
    const home = source.HOME && isAbsolute(source.HOME) ? source.HOME : homedir();
    Object.assign(env, { HOME: home, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) if (source[name]) env[name] = source[name]!;
    return env;
  }
  const cargoHome = operatorCargoHome(source).path ?? scratch.cargoHome;
  Object.assign(env, {
    HOME: scratch.home, CARGO_HOME: cargoHome, CARGO_NET_OFFLINE: "true",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    // A local repository's .git/config cannot start an fsmonitor hook for `git ls-files`.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
  });
  if (kind === "rust") Object.assign(env, rustEnv(rustToolchainPin(source)));
  return env;
}

/** Test seam: sees every scanner spawn (kind, command, args, the exact env passed). */
export type ScanSpawnObserver = (spawn: { kind: ScanChildKind; file: string; args: readonly string[]; env: Record<string, string>; cwd?: string }) => void;
let observer: ScanSpawnObserver | undefined;
export function observeScanSpawns(next: ScanSpawnObserver | undefined): void { observer = next; }

type EnvLess<T> = Omit<T, "env"> & { scratch?: ScanScratch };

/** `spawnSync` with the scanner environment. */
export function scanSpawnSync(kind: ScanChildKind, file: string, args: readonly string[], options: EnvLess<SpawnSyncOptions> & { encoding: BufferEncoding }): SpawnSyncReturns<string>;
export function scanSpawnSync(kind: ScanChildKind, file: string, args: readonly string[], options?: EnvLess<SpawnSyncOptions>): SpawnSyncReturns<Buffer | string>;
export function scanSpawnSync(kind: ScanChildKind, file: string, args: readonly string[], options: EnvLess<SpawnSyncOptions> = {}): SpawnSyncReturns<Buffer | string> {
  const { scratch, ...rest } = options;
  const env = scanChildEnv(kind, scratch);
  observer?.({ kind, file, args, env, ...(typeof rest.cwd === "string" ? { cwd: rest.cwd } : {}) });
  return spawnSync(file, args, { ...rest, env });
}

/** `execFileSync` with the scanner environment. */
export function scanExecFileSync(kind: ScanChildKind, file: string, args: readonly string[], options: EnvLess<ExecFileSyncOptions> & { encoding: BufferEncoding }): string;
export function scanExecFileSync(kind: ScanChildKind, file: string, args: readonly string[], options?: EnvLess<ExecFileSyncOptions>): Buffer;
export function scanExecFileSync(kind: ScanChildKind, file: string, args: readonly string[], options: EnvLess<ExecFileSyncOptions> = {}): string | Buffer {
  const { scratch, ...rest } = options;
  const env = scanChildEnv(kind, scratch);
  observer?.({ kind, file, args, env, ...(typeof rest.cwd === "string" ? { cwd: rest.cwd } : {}) });
  return execFileSync(file, args, { ...rest, env });
}
