import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scanSpawnSync } from "./scan-env.js";

/**
 * CLA-271 content-addressed cache for rust-analyzer SCIP indexes (opt-in via `rustIndexCacheDir`).
 *
 * Key: sha256 of the key schema, `rust-analyzer --version`, `rustc -vV` (release and host of the pinned scanner toolchain,
 * see scan-env.ts), the exact invocation variant (arguments without the machine-specific root/output paths, plus the
 * config file content, which carries the CLA-305 lockdown), and a digest of the tree (see rustInputDigest). SCIP document
 * paths are root-relative (the analyzer never reads `metadata.projectRoot`), so an index is valid for the same content at
 * another checkout path.
 *
 * CLA-305: build scripts and proc macros never run (analyze-rust.ts), so an index depends only on the tree, the pinned
 * toolchain and the invocation, never on what a build script found in the environment. scipStderrUncacheable stays as a
 * guard should rust-analyzer ever report such a failure.
 *
 * Hardening (CLA-305): the directory is created 0700 (an existing one we own is chmod-ed back to 0700); entries and temp
 * files are written 0600 with exclusive create; a read accepts only regular files (lstat: never a symlink), whose meta
 * names this exact key and whose bytes match the recorded sha256, anything else is a miss. A cache directory inside the
 * scanned tree is refused (the scan runs uncached). Entries are written atomically (temp file + rename, metadata last). A
 * failed run is never stored. A hit touches the entry's mtime; after a write the directory is swept oldest-first down to
 * a size cap (OKIE_SCIP_CACHE_MAX_MB, default 512) and temp files older than an hour are removed.
 */
/** Bumped whenever the invocation's meaning changes without the key noticing (3: CLA-305 lockdown and minimal env). */
export const SCIP_CACHE_KEY_SCHEMA = 3;
const SKIPPED_DIRECTORIES = new Set([".git"]);
export const DEFAULT_SCIP_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Files rust-analyzer can read anywhere in the tree, whatever the crate layout. */
function rustInput(path: string): boolean {
  const parts = path.split("/"); const name = parts.at(-1)!;
  return name.endsWith(".rs") || name === "Cargo.toml" || name === "Cargo.lock" || name.startsWith("rust-toolchain")
    || name === "rust-project.json" || name === "rust-analyzer.toml" || (parts.at(-2) === ".cargo" && name.startsWith("config"));
}

/**
 * sha256 over the sorted (root-relative path, content) of every Rust input: the named inputs above at any depth, plus
 * EVERY file under each crate root (a directory whose Cargo.toml has a `[package]` section), since `include!`,
 * `include_str!` and build scripts can read any of them. A virtual workspace manifest alone is not a crate root, so
 * non-Rust edits elsewhere in the repository keep their hits. Symlinks are hashed by their target text, never followed.
 * Nothing is skipped but `.git`: committed and tarball trees have no build output, so a `target/` is content.
 */
export function rustInputDigest(root: string): string {
  const entries: Array<{ path: string; directory: string; link: boolean }> = [];
  const crateRoots: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolute); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = relative(root, absolute).split(sep).join("/");
      entries.push({ path, directory: relative(root, directory).split(sep).join("/"), link: entry.isSymbolicLink() });
      if (entry.name === "Cargo.toml" && entry.isFile() && /^\s*\[package\]/m.test(readFileSync(absolute, "utf8"))) crateRoots.push(relative(root, directory).split(sep).join("/"));
    }
  };
  walk(root);
  const underCrate = (path: string) => crateRoots.some(crate => crate === "" || path.startsWith(`${crate}/`));
  const files = entries.filter(entry => rustInput(entry.path) || underCrate(entry.path)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = createHash("sha256");
  for (const entry of files) {
    const content = entry.link ? Buffer.from(`symlink:${readlinkSync(join(root, entry.path))}`) : readFileSync(join(root, entry.path));
    hash.update(`${entry.path}\u0000${entry.link ? "l" : "f"}\u0000${content.length}\u0000`); hash.update(content); hash.update("\u0000");
  }
  return hash.digest("hex");
}

let versionMemo: string | undefined;
/** `rust-analyzer --version` of the pinned toolchain, once per process; undefined when the tool is missing (the cache is then bypassed). */
export function rustAnalyzerVersion(): string | undefined {
  if (versionMemo !== undefined) return versionMemo || undefined;
  const run = scanSpawnSync("rust", "rust-analyzer", ["--version"], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
  versionMemo = run.status === 0 && !run.error ? run.stdout.trim() : "";
  return versionMemo || undefined;
}
let rustcMemo: string | undefined;
/**
 * `rustc -vV` release and host of the pinned scanner toolchain (scan-env.ts), once per process; undefined when unavailable.
 * It never runs in the scanned tree, so a repository rust-toolchain file cannot select (or install) the compiler.
 */
export function rustcIdentity(): string | undefined {
  if (rustcMemo !== undefined) return rustcMemo || undefined;
  const run = scanSpawnSync("rust", "rustc", ["-vV"], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
  const field = (name: string) => run.stdout?.split("\n").find(line => line.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  const release = run.status === 0 && !run.error ? field("release") : undefined; const host = release ? field("host") : undefined;
  rustcMemo = release && host ? `${release} ${host}` : "";
  return rustcMemo || undefined;
}

/**
 * Guard: true when stderr SAYS a build script or proc-macro failed. Since CLA-305 neither runs during a scan (the
 * lockdown config), so this should never fire; it stays so such an index is never cached if one ever does. Progress lines
 * ("rust-analyzer: Loading building proc-macros: thiserror-impl") are ignored, and failure words must be whole words, so a
 * crate name that merely contains "error" never disables the cache.
 */
export function scipStderrUncacheable(stderr: string): boolean {
  return stderr.split("\n").some(line => !/^\s*rust-analyzer: Loading\b/.test(line)
    && /(build[ -]?scripts?|proc[-_ ]?macros?)/i.test(line) && /\b(fail(?:s|ed|ure)?|errors?|panick(?:ed|ing))\b/i.test(line));
}

export interface ScipRunResult { bytes?: Buffer; stderr: string; error?: string }
export interface CachedScipRun extends ScipRunResult { cache: "hit" | "miss" | "off" }

function cacheMaxBytes(): number {
  const configured = Number.parseInt(process.env.OKIE_SCIP_CACHE_MAX_MB ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured * 1024 * 1024 : DEFAULT_SCIP_CACHE_MAX_BYTES;
}

/** Removes temp files older than an hour, then whole entries oldest-mtime first until the directory fits `maxBytes`. */
export function sweepScipCache(cacheDir: string, maxBytes = cacheMaxBytes(), now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(cacheDir); } catch { return; }
  const entries = new Map<string, { size: number; mtime: number }>();
  for (const name of names) {
    const path = join(cacheDir, name);
    let stat; try { stat = lstatSync(path); } catch { continue; }
    if (name.endsWith(".tmp")) { if (now - stat.mtimeMs > STALE_TEMP_MS) rmSync(path, { force: true }); continue; }
    const match = /^([0-9a-f]{64})\.(scip|json)$/.exec(name); if (!match) continue;
    const entry = entries.get(match[1]!) ?? { size: 0, mtime: 0 };
    entry.size += stat.size; if (match[2] === "scip") entry.mtime = stat.mtimeMs; else entry.mtime ||= stat.mtimeMs;
    entries.set(match[1]!, entry);
  }
  let total = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
  for (const [key, entry] of [...entries].sort((left, right) => left[1].mtime - right[1].mtime || (left[0] < right[0] ? -1 : 1))) {
    if (total <= maxBytes) break;
    rmSync(join(cacheDir, `${key}.json`), { force: true }); rmSync(join(cacheDir, `${key}.scip`), { force: true });
    total -= entry.size;
  }
}

/** Real path of `path`, or of its deepest existing ancestor joined with the rest (the cache dir may not exist yet). */
function realOrResolved(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { /* not there yet */ }
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realOrResolved(parent), basename(absolute));
}

/** True when `inner` is `outer` or below it, after resolving symlinks. */
export function pathWithin(inner: string, outer: string): boolean {
  const rel = relative(realOrResolved(outer), realOrResolved(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Makes `cacheDir` a private directory: created 0700; an existing directory owned by this uid is chmod-ed back to 0700.
 * Returns a reason when it must not be used (a symlink, not a directory, owned by someone else, or unusable).
 */
export function prepareScipCacheDir(cacheDir: string): string | undefined {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(cacheDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "the cache path is not a plain directory";
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) return "the cache directory belongs to another user";
      if ((stat.mode & 0o077) !== 0) chmodSync(cacheDir, 0o700);
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Reads a cache file only when it is a regular file (never through a symlink). */
function readRegular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  return readFileSync(path);
}

/** Exclusive-create 0600 temp file, then an atomic rename over the entry. */
function writeEntryFile(path: string, content: string | Buffer): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

/**
 * Returns the cached index for (`variant`, tree content) or runs `run` and stores a cacheable successful result. `stderr`
 * is not cached; only whether it reported duplicate SCIP symbols (the one stderr fact the analyzer uses).
 */
export function cachedScipIndex(input: { cacheDir?: string; root: string; variant: string; digest?: string; toolchain?: string; maxBytes?: number; run: () => ScipRunResult }): CachedScipRun {
  // A cache inside the scanned tree could be planted or read by the repository: refuse it.
  const cacheDir = input.cacheDir && !pathWithin(input.cacheDir, input.root) && !prepareScipCacheDir(input.cacheDir) ? input.cacheDir : undefined;
  const version = cacheDir ? rustAnalyzerVersion() : undefined;
  const toolchain = cacheDir ? input.toolchain ?? rustcIdentity() : undefined;
  if (!cacheDir || !version || !toolchain) return { ...input.run(), cache: "off" };
  const digest = input.digest ?? rustInputDigest(input.root);
  const key = createHash("sha256").update(JSON.stringify({ schema: SCIP_CACHE_KEY_SCHEMA, version, toolchain, variant: input.variant, digest })).digest("hex");
  const indexPath = join(cacheDir, `${key}.scip`); const metaPath = join(cacheDir, `${key}.json`);
  try {
    const meta = JSON.parse(readRegular(metaPath).toString("utf8")) as { key?: unknown; sha256?: unknown; duplicateSymbols?: unknown };
    const bytes = readRegular(indexPath);
    // The meta must name this key (a renamed or copied entry is a miss) and the bytes must match their recorded hash.
    if (meta.key === key && typeof meta.sha256 === "string" && createHash("sha256").update(bytes).digest("hex") === meta.sha256) {
      try { const now = new Date(); utimesSync(indexPath, now, now); utimesSync(metaPath, now, now); } catch { /* best effort LRU */ }
      return { bytes, stderr: meta.duplicateSymbols === true ? "duplicate scip symbols (cached)" : "", cache: "hit" };
    }
  } catch { /* absent, corrupt, partial or not a regular file: a miss */ }
  const result = input.run();
  if (result.bytes && !result.error && !scipStderrUncacheable(result.stderr)) {
    try {
      writeEntryFile(indexPath, result.bytes);
      writeEntryFile(metaPath, JSON.stringify({ key, sha256: createHash("sha256").update(result.bytes).digest("hex"), duplicateSymbols: result.stderr.includes("duplicate scip symbols"), version, toolchain, variant: input.variant }));
    } catch { rmSync(metaPath, { force: true }); }
    sweepScipCache(cacheDir, input.maxBytes ?? cacheMaxBytes());
  }
  return { ...result, cache: "miss" };
}
