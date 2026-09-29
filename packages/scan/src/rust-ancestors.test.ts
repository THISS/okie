import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeRust } from "./analyze-rust.js";
import { inspectRustAncestors, inspectWorkRoot, type AncestorFs } from "./rust-ancestors.js";
import { chooseScanWorkRoot, observeScanSpawns, scanWorkDir } from "./scan-env.js";
import { rustAnalyzerVersion } from "./scip-cache.js";

const ME = 501;
/** A fake filesystem: directories with owner/mode, and files by path. */
function fakeFs(dirs: Record<string, { uid?: number; mode?: number; entries?: string[] }>, files: Record<string, string> = {}, folded: readonly string[] = []): AncestorFs {
  return {
    // `folded`: paths an insensitive filesystem would resolve although no entry is stored under that exact name.
    exists: path => path in dirs || path in files || folded.includes(path),
    realpath: path => path,
    lstat: path => { const dir = dirs[path]; if (!dir) throw new Error(`ENOENT ${path}`); return { uid: dir.uid ?? ME, mode: dir.mode ?? 0o40755, isDirectory: () => true }; },
    readdir: path => dirs[path]?.entries ?? [],
    readFile: path => { if (!(path in files)) throw new Error(`ENOENT ${path}`); return files[path]!; },
  };
}
const ROOT_OWNED = { uid: 0, mode: 0o40755 };
const TREE = "/work/scan-1/tree/owner-repo-sha";
const HEALTHY = { "/": ROOT_OWNED, "/work": { mode: 0o40700 }, "/work/scan-1": { mode: 0o40700 }, "/work/scan-1/tree": { mode: 0o40700 } };

test("rust ancestors: private, root- or self-owned ancestors pass", () => {
  assert.deepEqual(inspectRustAncestors(TREE, { fs: fakeFs(HEALTHY), uid: ME }), { limitations: [], keyInputs: [] });
});

test("rust ancestors: a world-writable ancestor (Linux /tmp, sticky bit or not) or another user's ancestor refuses Rust analysis", () => {
  const tmpTree = "/tmp/okie-scan-gh-x/tree/owner-repo-sha";
  const tmp = { "/": ROOT_OWNED, "/tmp": { uid: 0, mode: 0o41777 }, "/tmp/okie-scan-gh-x": { mode: 0o40700 }, "/tmp/okie-scan-gh-x/tree": { mode: 0o40700 } };
  const refusal = inspectRustAncestors(tmpTree, { fs: fakeFs(tmp), uid: ME }).refusal ?? "";
  // Paths are rendered relative to the tree: deterministic, and no mkdtemp names or absolute paths in scan output.
  assert.match(refusal, /^Rust analysis skipped: \.\.\/\.\.\/\.\., an ancestor of the scanned tree, is group- or world-writable/);
  assert.match(refusal, /Set OKIE_SCAN_WORK_DIR/);
  assert.match(inspectRustAncestors(TREE, { fs: fakeFs({ ...HEALTHY, "/work/scan-1": { mode: 0o40770 } }), uid: ME }).refusal ?? "", /^Rust analysis skipped: \.\.\/\.\., an ancestor.*group- or world-writable/);
  assert.match(inspectRustAncestors(TREE, { fs: fakeFs({ ...HEALTHY, "/work": { uid: 1002, mode: 0o40755 } }), uid: ME }).refusal ?? "", /^Rust analysis skipped: \.\.\/\.\.\/\.\., an ancestor.*owned by another user \(uid 1002\)/);
  assert.equal(inspectRustAncestors(TREE, { fs: fakeFs({ ...HEALTHY, "/work": { uid: 1002, mode: 0o40777 } }), uid: undefined }).refusal, undefined, "no uid (Windows): ownership is not checked");
});

test("rust ancestors: an ancestor rust-project.json (any case) refuses; ancestor cargo config and manifests are recorded and keyed", () => {
  for (const name of ["rust-project.json", ".rust-project.json", "Rust-Project.JSON", "ru\u017Ft-project.json"]) {
    const fs = fakeFs({ ...HEALTHY, "/work": { mode: 0o40700, entries: ["scan-1", name] } });
    assert.match(inspectRustAncestors(TREE, { fs, uid: ME }).refusal ?? "", new RegExp(`\\.\\./\\.\\./\\.\\./${name.replace(/\./g, "\\.")} in an ancestor of the scanned tree would be loaded by rust-analyzer`), name);
  }
  // The filesystem layer: a stored name the folding misses, but that the filesystem resolves for rust-analyzer.
  const odd = fakeFs({ ...HEALTHY, "/work": { mode: 0o40700, entries: ["scan-1", "rust-proje\u0441t.json"] } }, {}, ["/work/rust-project.json"]);
  assert.match(inspectRustAncestors(TREE, { fs: odd, uid: ME }).refusal ?? "", /\.\.\/\.\.\/\.\.\/rust-project\.json in an ancestor/);
  const fs = fakeFs(
    { ...HEALTHY, "/": { ...ROOT_OWNED, entries: ["work", ".cargo"] }, "/work": { mode: 0o40700, entries: ["scan-1", "Cargo.toml"] }, "/.cargo": { ...ROOT_OWNED, entries: ["config.toml", "credentials.toml"] } },
    { "/.cargo/config.toml": "[net]\noffline = true\n", "/work/Cargo.toml": "[workspace]\nmembers = []\n" },
  );
  const report = inspectRustAncestors(TREE, { fs, uid: ME });
  assert.equal(report.refusal, undefined, "operator-owned cargo files are noted, not refused");
  assert.deepEqual(report.keyInputs, [
    { path: "/work/Cargo.toml", relative: "../../../Cargo.toml", content: "[workspace]\nmembers = []\n" },
    { path: "/.cargo/config.toml", relative: "../../../../.cargo/config.toml", content: "[net]\noffline = true\n" },
  ]);
  assert.ok(report.limitations.some(line => line.includes("(../../../Cargo.toml)") && line.includes("capture its crates")));
  assert.ok(report.limitations.includes("Operator cargo config in an ancestor of the scanned tree applies to Rust analysis: ../../../../.cargo/config.toml."));
  assert.ok(report.limitations.every(line => !line.includes("/work/") && !line.includes(" /.cargo")), "no absolute paths");
});

const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/lib.rs": "pub fn hello() -> u32 { helper() }\nfn helper() -> u32 { 1 }\n",
};
function layout(parentFiles: Record<string, string>): { parent: string; root: string } {
  const parent = mkdtempSync(join(tmpdir(), "okie-rust-ancestors-"));
  const root = join(parent, "child", "tree");
  for (const [path, text] of Object.entries({ ...Object.fromEntries(Object.entries(FILES).map(([path, text]) => [join("child/tree", path), text])), ...parentFiles })) {
    mkdirSync(dirname(join(parent, path)), { recursive: true }); writeFileSync(join(parent, path), text);
  }
  return { parent, root };
}

test("rust ancestors (real FS): a planted parent rust-project.json or a group-writable parent stops analysis before rust-analyzer runs", { skip: process.platform === "win32" ? "POSIX modes" : false }, () => {
  const spawned: string[] = [];
  observeScanSpawns(spawn => { spawned.push(spawn.file); });
  const planted = layout({ "child/Rust-Project.json": JSON.stringify({ sysroot: "/nonexistent", crates: [] }) });
  const writable = layout({});
  try {
    const refused = analyzeRust(planted.root, ["src/lib.rs"]);
    assert.equal(refused.coverage[0]?.coverage, "unavailable");
    assert.match(refused.coverage[0]!.limitations[0]!, /^Rust analysis skipped: \.\.\/(Rust-Project|rust-project)\.json in an ancestor of the scanned tree would be loaded by rust-analyzer/);
    chmodSync(join(writable.parent, "child"), 0o777);
    const open = analyzeRust(writable.root, ["src/lib.rs"]);
    assert.match(open.coverage[0]!.limitations[0]!, /^Rust analysis skipped: \.\., an ancestor of the scanned tree, is group- or world-writable/);
    assert.deepEqual(spawned.filter(file => file === "rust-analyzer"), [], "rust-analyzer never ran");
  } finally { observeScanSpawns(undefined); for (const path of [planted.parent, writable.parent]) rmSync(path, { recursive: true, force: true }); }
});

test("rust ancestors (real FS): an ancestor cargo config is noted and keyed, so changing it misses the SCIP cache", { timeout: 300_000 }, t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  // rust-analyzer may write a Cargo.lock into the tree it indexes, so every run gets its own fresh layout (as a scan does).
  const layouts = ["retry = 1", "retry = 1", "retry = 2"].map(line => layout({ "child/.cargo/config.toml": `[net]\n${line}\n` }));
  const cacheDir = mkdtempSync(join(tmpdir(), "okie-rust-ancestors-cache-"));
  try {
    const seen: string[] = []; const onIndex = (_variant: string, cache: string) => { seen.push(cache); };
    const runs = layouts.map(({ root }) => analyzeRust(root, ["src/lib.rs"], { indexCacheDir: cacheDir, onIndex }));
    assert.equal(runs[0]!.coverage[0]?.coverage, "semantic", JSON.stringify(runs[0]!.coverage));
    assert.ok(runs[0]!.coverage[0]!.limitations.some(line => line.startsWith("Operator cargo config in an ancestor")));
    assert.deepEqual(seen, ["miss", "hit", "miss"], "same ancestor config at another path hits; changed content misses");
  } finally { for (const { parent } of layouts) rmSync(parent, { recursive: true, force: true }); rmSync(cacheDir, { recursive: true, force: true }); }
});

test("scan work root: a dedicated dir under OKIE_SCAN_WORK_DIR, a safe tmpdir, XDG_RUNTIME_DIR or ~/.cache, else tmpdir with Rust refused", () => {
  const home = { "/": ROOT_OWNED, "/home": ROOT_OWNED, "/home/u": { mode: 0o40750 }, "/home/u/.cache": { mode: 0o40700 }, "/home/u/.cache/okie": { mode: 0o40700 }, "/home/u/.cache/okie/scan-work": { mode: 0o40700 } };
  const prepared: string[] = []; const prepare = (parent: string, ...names: string[]) => { const dir = join(parent, ...names); prepared.push(dir); return dir; };
  const choose = (dirs: Record<string, { uid?: number; mode?: number; entries?: string[] }>, tmp: string, source: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}) =>
    chooseScanWorkRoot({ source, tmp, home: "/home/u", fs: fakeFs(dirs, files), uid: ME, prepare });
  // macOS: the per-user T dir passes; the root is a dedicated subdir (the operator's TMPDIR itself is never chmod-ed).
  const mac = { "/": ROOT_OWNED, "/private": ROOT_OWNED, "/private/var": ROOT_OWNED, "/private/var/folders": ROOT_OWNED, "/private/var/folders/1t": ROOT_OWNED, "/private/var/folders/1t/abc": { mode: 0o40755 }, "/private/var/folders/1t/abc/T": { mode: 0o40700 } };
  assert.deepEqual(choose(mac, "/private/var/folders/1t/abc/T"), { root: "/private/var/folders/1t/abc/T/okie-scan-work", source: "tmpdir", rejected: [] });
  // Linux: /tmp is 1777, so XDG_RUNTIME_DIR (per-user, not under ~) is next, then ~/.cache.
  const linux = { ...home, "/tmp": { uid: 0, mode: 0o41777 }, "/run": ROOT_OWNED, "/run/user": ROOT_OWNED, "/run/user/501": { mode: 0o40700 } };
  const runtime = choose(linux, "/tmp", { XDG_RUNTIME_DIR: "/run/user/501" });
  assert.deepEqual([runtime.root, runtime.source], ["/run/user/501/okie-scan-work", "xdg-runtime"]);
  assert.match(runtime.rejected[0]!, /^tmpdir: \/tmp is group- or world-writable/);
  const onLinux = choose(linux, "/tmp");
  assert.deepEqual([onLinux.root, onLinux.source], ["/home/u/.cache/okie/scan-work", "user-cache"]);
  assert.equal(choose(linux, "/tmp", { XDG_CACHE_HOME: "/home/u/.cache" }).root, "/home/u/.cache/okie/scan-work");
  assert.equal(choose({ ...linux, "/run/user/501": { mode: 0o40777 } }, "/tmp", { XDG_RUNTIME_DIR: "/run/user/501" }).source, "user-cache", "an unsafe runtime dir falls through");
  // A TMPDIR inside a Cargo workspace falls through too, whatever spelling defines the workspace.
  const inWorkspace = { ...home, "/home/u": { mode: 0o40750, entries: ["proj"] }, "/home/u/proj": { mode: 0o40755, entries: ["Cargo.toml", "tmp"] }, "/home/u/proj/tmp": { mode: 0o40700 } };
  for (const manifest of ['[workspace]\nmembers = ["crates/*"]\n', "[ workspace ]\n", "[workspace.package]\nversion = \"1.0.0\"\n", "workspace.members = []\n", "workspace = { members = [] }\n"]) {
    const captured = choose(inWorkspace, "/home/u/proj/tmp", {}, { "/home/u/proj/Cargo.toml": manifest });
    assert.equal(captured.source, "user-cache", manifest); assert.match(captured.rejected[0]!, /Cargo workspace that would capture scanned crates/);
  }
  // A package manifest (no workspace) is not a reason to move.
  assert.equal(choose(inWorkspace, "/home/u/proj/tmp", {}, { "/home/u/proj/Cargo.toml": "[package]\nname = \"p\"\n" }).source, "tmpdir");
  // Nothing safe: tmpdir itself, and Rust analysis will refuse there.
  const hopeless = choose({ ...linux, "/home/u": { mode: 0o40777 } }, "/tmp");
  assert.equal(hopeless.source, "tmpdir-unsafe"); assert.equal(hopeless.root, "/tmp"); assert.equal(hopeless.rejected.length, 2);
  // The operator's explicit choice wins; the scanner uses (and chmods) only its own subdir of it.
  assert.deepEqual(choose(linux, "/tmp", { OKIE_SCAN_WORK_DIR: "/srv/okie-work" }), { root: "/srv/okie-work/okie-scan-work", source: "OKIE_SCAN_WORK_DIR", rejected: [] });
  assert.ok(prepared.includes("/srv/okie-work/okie-scan-work") && prepared.includes("/home/u/.cache/okie/scan-work"), "chosen private dirs are created 0700");
  assert.match(inspectWorkRoot("/tmp", { fs: fakeFs(linux), uid: ME }) ?? "", /world-writable/);
});

test("scan work root (real FS): OKIE_SCAN_WORK_DIR gets a private okie-scan-work subdir, the operator's dir keeps its mode, and a deleted root is recreated", { skip: process.platform === "win32" ? "POSIX modes" : false }, () => {
  const operator = mkdtempSync(join(tmpdir(), "okie-operator-work-"));
  chmodSync(operator, 0o755);
  try {
    const root = scanWorkDir({ ...process.env, OKIE_SCAN_WORK_DIR: operator });
    assert.equal(root, join(realpathSync(operator), "okie-scan-work"));
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(operator).mode & 0o777, 0o755, "never chmod the operator's directory");
    rmSync(root, { recursive: true });
    assert.equal(scanWorkDir({ ...process.env, OKIE_SCAN_WORK_DIR: operator }), root);
    assert.ok(statSync(root).isDirectory(), "recreated");
    // Someone else's pre-created (here: a symlinked) dedicated dir is never adopted.
    rmSync(root, { recursive: true }); symlinkSync(tmpdir(), root);
    assert.throws(() => scanWorkDir({ ...process.env, OKIE_SCAN_WORK_DIR: operator }), /not a plain directory/);
  } finally { rmSync(operator, { recursive: true, force: true }); }
});
