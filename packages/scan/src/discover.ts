import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { slug } from "./ids.js";

/**
 * A container-level unit of the repository: a workspace member, the whole repo
 * (single-package mode), the synthetic "tooling" bucket for non-member scripts, or
 * an opaque Rust crate (no source parsed). Import resolution maps a workspace package
 * name to a unit via `packageName`.
 */
export interface SourceUnit {
  kind: "member" | "root" | "tooling" | "rust";
  dir: string;
  name: string;
  packageName?: string;
  /** Repository-relative anchor for the container. */
  evidencePath: string;
}

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
}

function git(sourceRoot: string, args: readonly string[]): string[] {
  const out = execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return out.split("\n").map(line => line.trim()).filter(line => line.length > 0);
}

// Always scanned. `.js` is added only for pure-JS repos (no root tsconfig).
const ALWAYS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".jsx"] as const;

// Members that are test scaffolding, not architecture.
const FIXTURE_MEMBER_PATTERN = /(^|\/)(playground|playgrounds|examples?|example-.*|e2e|fixtures?|__fixtures__|demos?|sandbox)(\/|$)/i;

// Directories that never hold tracked source; skipped by the tarball walk. `.git`
// is absent from a tarball anyway (the whole point of the extract-scan-discard
// strategy); `node_modules` is never tracked, but excluded defensively so a stray
// vendored copy can never balloon the walk or leak into discovery.
const TARBALL_SKIP_DIRS = new Set([".git", "node_modules"]);

/** Test/generated files excluded from every scan (a named, tested list). */
function isExcludedPath(path: string): boolean {
  return /\.d\.ts$/.test(path)
    || /(^|\/)dist\//.test(path)
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /\.spec\.[cm]?[jt]sx?$/.test(path)
    || /\.bench\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)__tests__\//.test(path)
    || /(^|\/)__mocks__\//.test(path);
}

function hasExtension(path: string, includeJs: boolean): boolean {
  if (ALWAYS_EXTENSIONS.some(ext => path.endsWith(ext))) return true;
  return includeJs && path.endsWith(".js");
}

function hasRootTsconfig(sourceRoot: string): boolean {
  return ["tsconfig.json", "tsconfig.base.json"].some(file => existsSync(`${sourceRoot}/${file}`));
}

function readPackageName(sourceRoot: string, dir: string): string | undefined {
  const manifest = dir ? `${sourceRoot}/${dir}/package.json` : `${sourceRoot}/package.json`;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function workspaceGlobs(sourceRoot: string): string[] {
  let text: string;
  try {
    text = readFileSync(`${sourceRoot}/pnpm-workspace.yaml`, "utf8");
  } catch {
    return [];
  }
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

/** All tracked files at the current index/HEAD (gitignore-aware), repo-relative POSIX. */
function listTrackedFiles(sourceRoot: string): string[] {
  return git(sourceRoot, ["ls-files"]);
}

/**
 * Recursively lists every file under an extracted tree, repo-relative POSIX. A
 * GitHub codeload tarball already contains exactly the committed tree at the SHA
 * (untracked/gitignored content was never archived), so a plain walk reproduces
 * `git ls-files` for that commit — no `.gitignore` parsing required. Divergence to
 * note: `git archive` honors `.gitattributes export-ignore`, so a rare export-ignored
 * (but tracked) path is present under `git ls-files` yet absent from the tarball.
 */
function walkExtractedTree(root: string): string[] {
  const files: string[] = [];
  const visit = (relativeDir: string): void => {
    const absoluteDir = relativeDir ? `${root}/${relativeDir}` : root;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory() && TARBALL_SKIP_DIRS.has(entry.name)) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) files.push(relative);
      // symlinks and other non-regular entries are ignored (not source)
    }
  };
  visit("");
  return files;
}

/**
 * Pure discovery core over an already-listed set of repository-relative file paths
 * plus an `fs`-readable root (for `package.json`/`tsconfig`/`pnpm-workspace.yaml`).
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

  const allMembers = [...memberDirs].sort();
  const skippedMembers = options.includeAllMembers ? [] : allMembers.filter(dir => FIXTURE_MEMBER_PATTERN.test(dir));
  const skippedMemberSet = new Set(skippedMembers);
  const memberOf = (file: string): string | undefined =>
    allMembers.find(dir => file === dir || file.startsWith(`${dir}/`));

  const unitByFile = new Map<string, string>();
  const unitByPackageName = new Map<string, string>();
  const units: SourceUnit[] = [];
  const singlePackage = allMembers.length === 0;

  if (singlePackage) {
    // Whole repo is one package -> one container derived from the root manifest.
    const rootPackage = readPackageName(sourceRoot, "");
    const rootName = rootPackage ?? basename(sourceRoot);
    const rootKey = slug(rootName);
    for (const file of sourceCandidates) unitByFile.set(file, rootKey);
    units.push({
      kind: "root",
      dir: rootKey,
      name: rootName,
      ...(rootPackage ? { packageName: rootPackage } : {}),
      evidencePath: existsSync(`${sourceRoot}/package.json`) ? "package.json" : rootKey,
    });
    if (rootPackage) unitByPackageName.set(rootPackage, rootKey);
  } else {
    let hasTooling = false;
    for (const file of sourceCandidates) {
      const member = memberOf(file);
      if (member && skippedMemberSet.has(member)) continue; // fixture/example member — dropped
      if (member) unitByFile.set(file, member);
      else { unitByFile.set(file, "tooling"); hasTooling = true; }
    }
    const membersWithSource = allMembers
      .filter(dir => !skippedMemberSet.has(dir))
      .filter(dir => sourceCandidates.some(file => unitByFile.get(file) === dir));
    for (const dir of membersWithSource) {
      const name = readPackageName(sourceRoot, dir);
      units.push({ kind: "member", dir, name: name ?? dir, evidencePath: dir, ...(name ? { packageName: name } : {}) });
      if (name) unitByPackageName.set(name, dir);
    }
    if (hasTooling) {
      units.push({ kind: "tooling", dir: "tooling", name: "Build & fixture tooling", evidencePath: "scripts" });
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
    summary: { singlePackage, includedJs, skippedJsFiles, skippedMembers },
  };
}

/**
 * Deterministically discovers source files, containers, tooling, and Rust crates
 * from a local git working tree (gitignore-aware via `git ls-files`).
 */
export function discoverRepository(sourceRoot: string, options: DiscoverOptions = {}): Discovery {
  return discoverFromFiles(sourceRoot, listTrackedFiles(sourceRoot), options);
}

/**
 * Discovery for an extracted GitHub tarball: no `.git`, so files come from an `fs`
 * walk of the committed tree instead of `git ls-files`. Runs the identical core, so
 * the same repository content yields byte-identical discovery whether reached via a
 * local clone or a `gh:` tarball.
 */
export function discoverExtractedTree(root: string, options: DiscoverOptions = {}): Discovery {
  return discoverFromFiles(root, walkExtractedTree(root), options);
}
