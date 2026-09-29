import { scanExecFileSync } from "./scan-env.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import ts from "typescript";
import { resolveRelativeImport } from "./extract.js";
import { slug } from "./ids.js";
import {
  classifyFsSymlink,
  countSymlink,
  emptySkippedEntries,
  hasSkippedEntries,
  isBufferOverflow,
  mergeSkippedEntries,
  safeRegularFile,
  SCAN_SIZE_LIMITS,
  ScanSizeLimitError,
  walkRegularFiles,
  type ScanSizeLimits,
  type SkippedTreeEntries,
} from "./source-tree.js";

/**
 * A container-level unit of the repository: a workspace member, the whole repo
 * (single-package mode), the synthetic "tooling" bucket for non-member scripts, or
 * a Rust crate (`.rs` outlined via tree-sitter). Import resolution maps a workspace package
 * name to a unit via `packageName`.
 */
export interface SourceUnit {
  kind: "member" | "root" | "tooling" | "rust";
  /**
   * The unit key (`unitByFile` value): the member/crate directory, the root slug, or
   * {@link TOOLING_UNIT_KEY} for the synthetic bucket. The container id is derived
   * via `slug`, so the bucket is still `container:tooling`.
   */
  dir: string;
  name: string;
  packageName?: string;
  /** Repository-relative anchor for the container. */
  evidencePath: string;
}

/**
 * Unit key of the synthetic non-member bucket. It can never be a repository path
 * (NUL is not a valid path byte), so a workspace member literally named `tooling`
 * keeps its own unit instead of sharing — and losing its files to — the bucket.
 * `slug` drops the NUL, so the container id stays `container:tooling`.
 */
export const TOOLING_UNIT_KEY = "\0tooling";

/** Visible accounting of what discovery included and deliberately left out. */
export interface DiscoverySummary {
  /** No workspace members — the whole repo is one container. */
  singlePackage: boolean;
  /** `.js` files scanned (true) or skipped as a TypeScript repo (false). */
  includedJs: boolean;
  /** `.js` files skipped because the repo has a root tsconfig (never silent). */
  skippedJsFiles: number;
  /** Workspace members skipped as fixtures/examples/playgrounds/e2e. */
  skippedMembers: string[];
  /**
   * Pure re-export shims outside every workspace member (e.g. a root Vercel
   * `api/share.ts` that is only `export { default } from '../apps/web/api/share.ts'`)
   * folded into the unit that owns their target instead of becoming a second
   * component in the tooling bucket. Sorted by `path`. Never evidence (not a
   * sourceRef): persisted in the scan's membership report / portable-atlas
   * `analysis.membership`, and importers of a shim resolve to its target.
   */
  reexportAliases?: ReexportAlias[];
  /**
   * Tracked symlinks (in-repo ones kept for config/imports; escaping, dangling and looping ones removed) and submodules, none scanned as source files (CLA-299).
   * Present only when at least one count is non-zero; rendered into the scan's
   * `analysis.limitations`.
   */
  skippedEntries?: SkippedTreeEntries;
  /**
   * Source-extension files excluded because they live under a conventional test-data
   * directory (see `isTestDataPath`). Present only when non-zero.
   */
  excludedTestDataFiles?: number;
}

/** A re-export shim folded into the component of the file it re-exports. */
export interface ReexportAlias {
  /** The shim's repository-relative path (not emitted as its own component). */
  path: string;
  /** The re-exported source file whose component absorbs the shim. */
  target: string;
  /** The unit dir owning `target` (never the tooling bucket). */
  unit: string;
}

export interface Discovery {
  /** Canonically-sorted repository-relative source paths. */
  sourceFiles: string[];
  units: SourceUnit[];
  /** file path -> owning unit dir. */
  unitByFile: Map<string, string>;
  /** workspace package name -> owning unit dir. */
  unitByPackageName: Map<string, string>;
  summary: DiscoverySummary;
}

export interface DiscoverOptions {
  /** Scan workspace members that look like fixtures/examples/playgrounds/e2e too. */
  includeAllMembers?: boolean;
  /**
   * Fold pure re-export shims outside every member into their target (default
   * true). `false` reproduces the pre-CLA-263 shape — each shim is its own
   * tooling component — which the membership diagnostic must then flag.
   */
  foldReexportShims?: boolean;
  /**
   * Entries the acquisition step already skipped (e.g. committed symlinks that were
   * never materialized); merged into `summary.skippedEntries`.
   */
  skippedEntries?: SkippedTreeEntries;
  /** Test seam: override {@link SCAN_SIZE_LIMITS} for the tracked-file listing. */
  limits?: Partial<ScanSizeLimits>;
}

// Always scanned. `.js` is added only for pure-JS repos (no root tsconfig).
const ALWAYS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".jsx", ".rs"] as const;

// Members that are test scaffolding, not architecture.
const FIXTURE_MEMBER_PATTERN = /(^|\/)(playground|playgrounds|examples?|example-.*|e2e|fixtures?|__fixtures__|demos?|sandbox)(\/|$)/i;

// Directories that never hold tracked source; skipped by the tarball walk. `.git`
// is absent from a tarball anyway (the whole point of the extract-scan-discard
// strategy); `node_modules` is never tracked, but excluded defensively so a stray
// vendored copy can never balloon the walk or leak into discovery.
const TARBALL_SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Conventional test-data directories: `testdata/` is the Go toolchain's reserved
 * fixture directory (ignored by `go build`) and is used the same way by other
 * ecosystems — compiler test cases, golden baselines, deliberately malformed input.
 * Never architecture; e.g. microsoft/TypeScript keeps ~61k generated files there.
 * Excluded files are counted in `DiscoverySummary.excludedTestDataFiles`.
 */
export function isTestDataPath(path: string): boolean {
  return /(^|\/)testdata\//.test(path);
}

/** Test/generated files excluded from every scan (a named, tested list). */
function isExcludedPath(path: string): boolean {
  return isTestDataPath(path) || isExcludedFile(path);
}

/** The per-file exclusions (everything in `isExcludedPath` except test-data directories). */
function isExcludedFile(path: string): boolean {
  return /\.d\.ts$/.test(path)
    || /(^|\/)dist\//.test(path)
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /\.spec\.[cm]?[jt]sx?$/.test(path)
    || /\.bench\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)__tests__\//.test(path)
    || /(^|\/)__mocks__\//.test(path)
    || /_qa\.rs$/.test(path)
    // Not `*_test.rs`: production modules can be named `hit_test.rs`.
    || (path.endsWith(".rs") && /(^|\/)(tests|benches|examples)\//.test(path));
}

function hasExtension(path: string, includeJs: boolean): boolean {
  if (ALWAYS_EXTENSIONS.some(ext => path.endsWith(ext))) return true;
  return includeJs && path.endsWith(".js");
}

/**
 * Reads a repository-relative config/source file only when it is a regular file
 * reached without any symlink (never follows a link outside — or inside — the root).
 */
function readRepositoryFile(sourceRoot: string, relativePath: string): string | undefined {
  const path = safeRegularFile(sourceRoot, relativePath);
  if (!path) return undefined;
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function hasRootTsconfig(sourceRoot: string): boolean {
  return ["tsconfig.json", "tsconfig.base.json"].some(file => safeRegularFile(sourceRoot, file) !== undefined);
}

function readPackageName(sourceRoot: string, dir: string): string | undefined {
  const text = readRepositoryFile(sourceRoot, dir ? `${dir}/package.json` : "package.json");
  if (text === undefined) return undefined;
  try {
    const pkg = JSON.parse(text) as { name?: string };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function workspaceGlobs(sourceRoot: string): string[] {
  const text = readRepositoryFile(sourceRoot, "pnpm-workspace.yaml");
  if (text === undefined) return [];
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const match = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (match) globs.push(match[1]!);
      else if (/^\S/.test(line)) break;
    }
  }
  return globs;
}

/**
 * pnpm workspace glob -> anchored RegExp over a POSIX directory path. `*` matches a
 * single path segment (pnpm's `packages/*` = direct children); `**` matches one or
 * more segments. Kept deliberately small — it only has to cover the pnpm glob shapes
 * that appear in a `pnpm-workspace.yaml` packages list.
 */
function workspaceGlobToRegExp(glob: string): RegExp {
  const source = glob.split("/").map(segment =>
    segment === "**"
      ? "[^/]+(?:/[^/]+)*"
      : segment.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^/]*"),
  ).join("/");
  return new RegExp(`^${source}$`);
}

function isWorkspaceMemberDir(dir: string, globs: readonly string[]): boolean {
  return globs.some(glob => workspaceGlobToRegExp(glob).test(dir));
}

/**
 * The most specific (longest) directory in `dirs` containing `file`, or undefined.
 * With nested roots (`apps/web` and `apps/web/api` both packages) a file under
 * `apps/web/api/` belongs to the nested member only — container membership is
 * exclusive and the deepest package root wins, independent of `dirs` order.
 */
export function mostSpecificRoot(file: string, dirs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const dir of dirs) {
    if (file !== dir && !file.startsWith(`${dir}/`)) continue;
    if (best === undefined || dir.length > best.length) best = dir;
  }
  return best;
}

const REEXPORT_SHIM_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const REEXPORT_SHIM_MAX_CHARS = 8 * 1024;

/**
 * Relative specifiers of a file whose top-level statements are ALL re-exports
 * (`export { a } from './x'`, `export * from './x'`); undefined for anything else
 * (a declaration, an import, a bare-specifier re-export, an empty file).
 */
export function pureRelativeReexportSpecifiers(path: string, text: string): string[] | undefined {
  if (!REEXPORT_SHIM_EXTENSION.test(path)) return undefined;
  // Cheap prefilter before a parse: a shim is short and must re-export `from` somewhere.
  if (text.length > REEXPORT_SHIM_MAX_CHARS || !/\bexport\b/.test(text) || !/\bfrom\b/.test(text)) return undefined;
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  if (sourceFile.statements.length === 0) return undefined;
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) return undefined;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return undefined;
    specifiers.push(specifier.text);
  }
  return specifiers;
}

/**
 * Folds pure re-export shims out of the tooling bucket: a NON-MEMBER file whose
 * statements only re-export relative files that ALL resolve to one discovered
 * file owned by a workspace member / Rust crate (never another non-member file)
 * is removed from `unitByFile` and `nonMemberFiles` and recorded as an alias of
 * that target. Returns aliases sorted by path. Unreadable / unresolved /
 * multi-target shims stay as-is. Membership is decided by the `nonMemberFiles`
 * set, never by the bucket's unit key.
 */
function foldReexportShims(sourceRoot: string, unitByFile: Map<string, string>, nonMemberFiles: Set<string>): ReexportAlias[] {
  const fileSet = new Set(unitByFile.keys());
  const aliases: ReexportAlias[] = [];
  for (const file of [...nonMemberFiles].sort()) {
    const text = readRepositoryFile(sourceRoot, file);
    if (text === undefined) continue;
    const specifiers = pureRelativeReexportSpecifiers(file, text);
    if (!specifiers) continue;
    const targets = new Set(specifiers.map(specifier => resolveRelativeImport(file, specifier, fileSet)));
    if (targets.size !== 1) continue;
    const target = [...targets][0];
    const targetUnit = target ? unitByFile.get(target) : undefined;
    if (!target || target === file || !targetUnit || nonMemberFiles.has(target)) continue;
    aliases.push({ path: file, target, unit: targetUnit });
  }
  for (const alias of aliases) {
    unitByFile.delete(alias.path);
    nonMemberFiles.delete(alias.path);
  }
  return aliases;
}

/**
 * All tracked regular files at the current index (gitignore-aware), repo-relative
 * POSIX. Symlinks (mode 120000) and submodules (160000) are skipped and counted; the
 * listing is bounded by {@link SCAN_SIZE_LIMITS} (typed {@link ScanSizeLimitError}).
 */
function listTrackedFiles(sourceRoot: string, limits: ScanSizeLimits): { files: string[]; skipped: SkippedTreeEntries } {
  let out: string;
  try {
    out = scanExecFileSync("git", "git", ["ls-files", "-s", "-z"], { cwd: sourceRoot, encoding: "utf8", maxBuffer: limits.maxListingBytes });
  } catch (error) {
    if (isBufferOverflow(error)) throw new ScanSizeLimitError("listing", limits.maxListingBytes, limits.maxListingBytes);
    throw error;
  }
  const files: string[] = [];
  const skipped = emptySkippedEntries();
  const seen = new Set<string>();
  for (const record of out.split("\0")) {
    // `<mode> <object> <stage>\t<path>`; unmerged paths appear once per stage.
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const mode = record.slice(0, record.indexOf(" "));
    const path = record.slice(tab + 1);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (mode === "160000") skipped.submodules += 1;
    else if (mode === "120000") countSymlink(skipped, classifyFsSymlink(sourceRoot, `${sourceRoot}/${path}`));
    else files.push(path);
  }
  if (files.length > limits.maxFiles) throw new ScanSizeLimitError("files", limits.maxFiles, files.length);
  return { files, skipped };
}

/**
 * Recursively lists every regular file under an extracted tree, repo-relative POSIX. A
 * GitHub codeload tarball already contains exactly the committed tree at the SHA
 * (untracked/gitignored content was never archived), so a plain walk reproduces
 * `git ls-files` for that commit — no `.gitignore` parsing required. Divergence to
 * note: `git archive` honors `.gitattributes export-ignore`, so a rare export-ignored
 * (but tracked) path is present under `git ls-files` yet absent from the tarball.
 * Symlinks are never listed as source files and a symlinked directory is never
 * descended; the links still present (in-repo, kept for config/import resolution) are
 * counted and classified in `skipped`.
 */
function walkExtractedTree(root: string, limits: ScanSizeLimits): { files: string[]; skipped: SkippedTreeEntries } {
  const walked = walkRegularFiles(root, TARBALL_SKIP_DIRS);
  if (walked.files.length > limits.maxFiles) throw new ScanSizeLimitError("files", limits.maxFiles, walked.files.length);
  return walked;
}

/**
 * Pure discovery core over an already-listed set of repository-relative file paths
 * plus an `fs`-readable root (for `package.json`/`tsconfig`/`pnpm-workspace.yaml`,
 * and the text of non-member source files checked for re-export shims).
 * Both the git (`git ls-files`) and tarball (`fs` walk) providers feed the SAME core,
 * so a repo scanned either way yields identical containers/units/sort — the property
 * the byte-identical determinism contract needs.
 */
export function discoverFromFiles(sourceRoot: string, allFiles: readonly string[], options: DiscoverOptions = {}): Discovery {
  const candidates = allFiles.filter(path => hasExtension(path, true));
  // `.js` is scanned only for a genuinely pure-JS repo: no root tsconfig AND no TS
  // source anywhere (a monorepo can be TS without a root tsconfig).
  const hasTypeScriptSource = candidates.some(path => /\.(ts|tsx|mts|cts)$/.test(path) && !isExcludedPath(path));
  const includedJs = !hasRootTsconfig(sourceRoot) && !hasTypeScriptSource;
  const sourceCandidates = candidates.filter(path => hasExtension(path, includedJs) && !isExcludedPath(path));
  const skippedJsFiles = includedJs ? 0 : candidates.filter(path => path.endsWith(".js") && !isExcludedPath(path)).length;
  // Only files the testdata rule newly excludes (a testdata `.d.ts` / `*.test.ts` was already out).
  const excludedTestDataFiles = candidates.filter(path => hasExtension(path, includedJs) && isTestDataPath(path) && !isExcludedFile(path)).length;

  const globs = workspaceGlobs(sourceRoot);
  const memberDirs = new Set<string>();
  for (const path of allFiles) {
    if (!path.endsWith("/package.json") && path !== "package.json") continue;
    if (path === "package.json") continue; // the root manifest is not a workspace member
    const dir = path.slice(0, -"/package.json".length);
    if (isWorkspaceMemberDir(dir, globs)) memberDirs.add(dir);
  }
  const rustCrateDirs = allFiles
    .filter(path => /^crates\/[^/]+\/Cargo\.toml$/.test(path))
    .map(manifest => manifest.replace(/\/Cargo\.toml$/, "")).sort();
  const rustCrateOf = (file: string): string | undefined => mostSpecificRoot(file, rustCrateDirs);

  const allMembers = [...memberDirs].sort();
  const skippedMembers = options.includeAllMembers ? [] : allMembers.filter(dir => FIXTURE_MEMBER_PATTERN.test(dir));
  const skippedMemberSet = new Set(skippedMembers);
  const memberOf = (file: string): string | undefined => mostSpecificRoot(file, allMembers);

  const unitByFile = new Map<string, string>();
  const unitByPackageName = new Map<string, string>();
  const units: SourceUnit[] = [];
  const singlePackage = allMembers.length === 0;
  let reexportAliases: ReexportAlias[] = [];

  if (singlePackage) {
    // Whole repo is one package -> one container derived from the root manifest.
    const rootPackage = readPackageName(sourceRoot, "");
    const rootName = rootPackage ?? basename(sourceRoot);
    const rootKey = slug(rootName);
    for (const file of sourceCandidates) unitByFile.set(file, rustCrateOf(file) ?? rootKey);
    units.push({
      kind: "root",
      dir: rootKey,
      name: rootName,
      ...(rootPackage ? { packageName: rootPackage } : {}),
      evidencePath: safeRegularFile(sourceRoot, "package.json") ? "package.json" : rootKey,
    });
    if (rootPackage) unitByPackageName.set(rootPackage, rootKey);
  } else {
    const nonMemberFiles = new Set<string>();
    for (const file of sourceCandidates) {
      const rustCrate = rustCrateOf(file);
      if (rustCrate) {
        unitByFile.set(file, rustCrate);
        continue;
      }
      const member = memberOf(file);
      if (member && skippedMemberSet.has(member)) continue; // fixture/example member — dropped
      if (member) unitByFile.set(file, member);
      else { unitByFile.set(file, TOOLING_UNIT_KEY); nonMemberFiles.add(file); }
    }
    if (options.foldReexportShims !== false) reexportAliases = foldReexportShims(sourceRoot, unitByFile, nonMemberFiles);
    // Pruned when every non-member file was a folded shim.
    const hasTooling = nonMemberFiles.size > 0;
    const membersWithSource = allMembers
      .filter(dir => !skippedMemberSet.has(dir))
      .filter(dir => sourceCandidates.some(file => unitByFile.get(file) === dir));
    for (const dir of membersWithSource) {
      const name = readPackageName(sourceRoot, dir);
      units.push({ kind: "member", dir, name: name ?? dir, evidencePath: dir, ...(name ? { packageName: name } : {}) });
      if (name) unitByPackageName.set(name, dir);
    }
    if (hasTooling) {
      units.push({ kind: "tooling", dir: TOOLING_UNIT_KEY, name: "Build & fixture tooling", evidencePath: "scripts" });
    }
  }

  for (const dir of rustCrateDirs) {
    units.push({ kind: "rust", dir, name: dir.replace(/^crates\//, ""), evidencePath: dir });
  }

  const sourceFiles = [...unitByFile.keys()].sort();
  return {
    sourceFiles,
    units,
    unitByFile,
    unitByPackageName,
    summary: {
      singlePackage,
      includedJs,
      skippedJsFiles,
      skippedMembers,
      ...(reexportAliases.length > 0 ? { reexportAliases } : {}),
      ...(hasSkippedEntries(options.skippedEntries) ? { skippedEntries: { ...options.skippedEntries } } : {}),
      ...(excludedTestDataFiles > 0 ? { excludedTestDataFiles } : {}),
    },
  };
}

/**
 * Deterministically discovers source files, containers, tooling, and Rust crates
 * from a local git working tree (gitignore-aware via `git ls-files`).
 */
export function discoverRepository(sourceRoot: string, options: DiscoverOptions = {}): Discovery {
  const listed = listTrackedFiles(sourceRoot, { ...SCAN_SIZE_LIMITS, ...options.limits });
  return discoverFromFiles(sourceRoot, listed.files, { ...options, skippedEntries: mergeSkippedEntries(options.skippedEntries, listed.skipped) });
}

/**
 * Discovery for an extracted GitHub tarball: no `.git`, so files come from an `fs`
 * walk of the committed tree instead of `git ls-files`. Runs the identical core, so
 * the same repository content yields byte-identical discovery whether reached via a
 * local clone or a `gh:` tarball.
 */
export function discoverExtractedTree(root: string, options: DiscoverOptions = {}): Discovery {
  const walked = walkExtractedTree(root, { ...SCAN_SIZE_LIMITS, ...options.limits });
  return discoverFromFiles(root, walked.files, { ...options, skippedEntries: mergeSkippedEntries(options.skippedEntries, walked.skipped) });
}
