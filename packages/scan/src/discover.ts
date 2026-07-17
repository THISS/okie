import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A container-level unit of the repository: a workspace member, the synthetic
 * "tooling" bucket for non-member scripts, or an opaque Rust crate (no source
 * parsed in R1). Import resolution maps `@okie/*` specifiers to a unit via
 * `packageName`.
 */
export interface SourceUnit {
  kind: "member" | "tooling" | "rust";
  dir: string;
  name: string;
  packageName?: string;
  /** Repository-relative anchor for the container (the unit's own directory). */
  evidencePath: string;
}

export interface Discovery {
  /** Canonically-sorted repository-relative .ts/.tsx/.mjs source paths. */
  sourceFiles: string[];
  units: SourceUnit[];
  /** file path -> owning unit dir. */
  unitByFile: Map<string, string>;
  /** `@okie/x` package name -> owning unit dir (workspace members only). */
  unitByPackageName: Map<string, string>;
}

function git(sourceRoot: string, args: readonly string[]): string[] {
  const out = execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").map(line => line.trim()).filter(line => line.length > 0);
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs"] as const;

function isScannableSource(path: string): boolean {
  if (!SOURCE_EXTENSIONS.some(ext => path.endsWith(ext))) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/(^|\/)dist\//.test(path)) return false;
  if (/\.test\.[cm]?tsx?$/.test(path) || /\.test\.mjs$/.test(path)) return false;
  return true;
}

/** Reads the `packages:` globs from pnpm-workspace.yaml (top-level dir globs only). */
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
      else if (/^\S/.test(line)) break; // next top-level key ends the list
    }
  }
  return globs;
}

function packageName(sourceRoot: string, memberDir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(`${sourceRoot}/${memberDir}/package.json`, "utf8")) as { name?: string };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** Deterministically discovers source files, workspace members, tooling, and Rust crates. */
export function discoverRepository(sourceRoot: string): Discovery {
  const sourceFiles = git(sourceRoot, ["ls-files", "--", "*.ts", "*.tsx", "*.mjs"])
    .filter(isScannableSource)
    .sort();

  // Workspace members: directories matched by the pnpm globs that carry a package.json.
  const memberDirs = new Set<string>();
  for (const glob of workspaceGlobs(sourceRoot)) {
    for (const manifest of git(sourceRoot, ["ls-files", "--", `${glob}/package.json`])) {
      memberDirs.add(manifest.replace(/\/package\.json$/, ""));
    }
  }
  const rustCrateDirs = git(sourceRoot, ["ls-files", "--", "crates/*/Cargo.toml"])
    .map(manifest => manifest.replace(/\/Cargo\.toml$/, ""))
    .sort();

  const sortedMembers = [...memberDirs].sort();
  const unitByFile = new Map<string, string>();
  const memberOf = (file: string): string | undefined =>
    sortedMembers.find(dir => file === dir || file.startsWith(`${dir}/`));

  let hasTooling = false;
  for (const file of sourceFiles) {
    const member = memberOf(file);
    if (member) unitByFile.set(file, member);
    else { unitByFile.set(file, "tooling"); hasTooling = true; }
  }

  // Only members that actually own scanned source become containers.
  const membersWithSource = sortedMembers.filter(dir => sourceFiles.some(file => unitByFile.get(file) === dir));

  const units: SourceUnit[] = [];
  const unitByPackageName = new Map<string, string>();
  for (const dir of membersWithSource) {
    const name = packageName(sourceRoot, dir);
    units.push({ kind: "member", dir, name: name ?? dir, evidencePath: dir, ...(name ? { packageName: name } : {}) });
    if (name) unitByPackageName.set(name, dir);
  }
  if (hasTooling) {
    units.push({ kind: "tooling", dir: "tooling", name: "Build & fixture tooling", evidencePath: "scripts" });
  }
  for (const dir of rustCrateDirs) {
    units.push({ kind: "rust", dir, name: dir.replace(/^crates\//, ""), evidencePath: dir });
  }

  return { sourceFiles, units, unitByFile, unitByPackageName };
}
