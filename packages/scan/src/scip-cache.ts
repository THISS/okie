import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * CLA-271 content-addressed cache for rust-analyzer SCIP indexes (opt-in via `rustIndexCacheDir`).
 *
 * Key: sha256 of `rust-analyzer --version`, `rustc -vV` (release and host, resolved in the tree so a rust-toolchain file
 * applies), the exact invocation variant (arguments without the machine-specific root/output paths, plus any config
 * file content), and a digest of the tree (see rustInputDigest). SCIP document paths are root-relative (the analyzer
 * never reads `metadata.projectRoot`), so an index is valid for the same content at another checkout path.
 *
 * Entries are written atomically (temp file + rename, metadata last); an entry whose bytes do not match their recorded
 * sha256, or that cannot be read, is a miss. A failed run is never stored. Build-script and proc-macro failure detection
 * is best-effort only: rust-analyzer 1.87 `scip` prints nothing and exits 0 when a build script panics or a proc-macro
 * fails to build, so an index that depends on the environment (e.g. a build script that panics without some system
 * library) can be cached and served for the same tree later. Real detection is a follow-up. A hit touches the entry's mtime; after a write the
 * directory is swept oldest-first down to a size cap (OKIE_SCIP_CACHE_MAX_MB, default 512) and temp files older than an
 * hour are removed.
 */
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
/** `rust-analyzer --version`, once per process; undefined when the tool is missing (the cache is then bypassed). */
export function rustAnalyzerVersion(): string | undefined {
  if (versionMemo !== undefined) return versionMemo || undefined;
  const run = spawnSync("rust-analyzer", ["--version"], { encoding: "utf8", timeout: 30_000 });
  versionMemo = run.status === 0 && !run.error ? run.stdout.trim() : "";
  return versionMemo || undefined;
}
/** `rustc -vV` release and host, resolved in `root` (a rust-toolchain file there applies); undefined when unavailable. */
export function rustcIdentity(root: string): string | undefined {
  const run = spawnSync("rustc", ["-vV"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0 || run.error) return undefined;
  const field = (name: string) => run.stdout.split("\n").find(line => line.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  const release = field("release"); const host = field("host");
  return release && host ? `${release} ${host}` : undefined;
}

/**
 * Best-effort: true when stderr SAYS a build script or proc-macro failed (the index then depends on the environment, not
 * only the tree). rust-analyzer 1.87 reports no such failure on stderr (it exits 0 and prints only progress), so in
 * practice this rarely fires; see the module comment for the gap. Progress lines
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
    let stat; try { stat = statSync(path); } catch { continue; }
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

/**
 * Returns the cached index for (`variant`, tree content) or runs `run` and stores a cacheable successful result. `stderr`
 * is not cached; only whether it reported duplicate SCIP symbols (the one stderr fact the analyzer uses).
 */
export function cachedScipIndex(input: { cacheDir?: string; root: string; variant: string; digest?: string; toolchain?: string; maxBytes?: number; run: () => ScipRunResult }): CachedScipRun {
  const version = input.cacheDir ? rustAnalyzerVersion() : undefined;
  const toolchain = input.cacheDir ? input.toolchain ?? rustcIdentity(input.root) : undefined;
  if (!input.cacheDir || !version || !toolchain) return { ...input.run(), cache: "off" };
  const digest = input.digest ?? rustInputDigest(input.root);
  const key = createHash("sha256").update(JSON.stringify({ schema: 2, version, toolchain, variant: input.variant, digest })).digest("hex");
  const indexPath = join(input.cacheDir, `${key}.scip`); const metaPath = join(input.cacheDir, `${key}.json`);
  try {
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { sha256?: unknown; duplicateSymbols?: unknown };
      const bytes = readFileSync(indexPath);
      if (typeof meta.sha256 === "string" && createHash("sha256").update(bytes).digest("hex") === meta.sha256) {
        try { const now = new Date(); utimesSync(indexPath, now, now); utimesSync(metaPath, now, now); } catch { /* best effort LRU */ }
        return { bytes, stderr: meta.duplicateSymbols === true ? "duplicate scip symbols (cached)" : "", cache: "hit" };
      }
    }
  } catch { /* corrupt or partial entry: a miss */ }
  const result = input.run();
  if (result.bytes && !result.error && !scipStderrUncacheable(result.stderr)) {
    try {
      mkdirSync(input.cacheDir, { recursive: true });
      const suffix = `.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(indexPath + suffix, result.bytes); renameSync(indexPath + suffix, indexPath);
      writeFileSync(metaPath + suffix, JSON.stringify({ sha256: createHash("sha256").update(result.bytes).digest("hex"), duplicateSymbols: result.stderr.includes("duplicate scip symbols"), version, toolchain, variant: input.variant })); renameSync(metaPath + suffix, metaPath);
    } catch { rmSync(metaPath, { force: true }); }
    sweepScipCache(input.cacheDir, input.maxBytes ?? cacheMaxBytes());
  }
  return { ...result, cache: "miss" };
}

