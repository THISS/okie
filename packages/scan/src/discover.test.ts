import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { discoverExtractedTree, discoverRepository } from "./discover.js";
import { scanRepository } from "./scan.js";

/** Builds a tiny staged git repo (git ls-files sees staged files — no commit needed). */
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "okie-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function withRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = makeRepo(files);
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("single-package repo (no workspace) becomes one root container named from package.json", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "acme-lib" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/util.ts": "export function y() {}\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.singlePackage, true);
    const root = discovery.units.find(unit => unit.kind === "root")!;
    assert.ok(root, "one root container");
    assert.equal(root.dir, "acme-lib");
    assert.equal(root.name, "acme-lib");
    assert.equal(root.evidencePath, "package.json");
    assert.ok(!discovery.units.some(unit => unit.kind === "tooling"), "no synthetic tooling container");
    assert.deepEqual([...new Set(discovery.unitByFile.values())], ["acme-lib"]);
    assert.deepEqual(discovery.sourceFiles, ["src/index.ts", "src/util.ts"]);
  });
});

test("discovers .mts/.cts/.cjs/.jsx; skips .js in a TS repo (counted); includes .js only in a pure-JS repo", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "m" }),
    "tsconfig.json": "{}",
    "a.mts": "export const a = 1;\n",
    "b.cts": "export const b = 1;\n",
    "c.cjs": "module.exports = {};\n",
    "d.jsx": "export const D = 1;\n",
    "e.ts": "export const e = 1;\n",
    "legacy.js": "module.exports = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    for (const file of ["a.mts", "b.cts", "c.cjs", "d.jsx", "e.ts"]) assert.ok(discovery.sourceFiles.includes(file), `${file} discovered`);
    assert.ok(!discovery.sourceFiles.includes("legacy.js"), ".js skipped in a TS repo");
    assert.equal(discovery.summary.includedJs, false);
    assert.equal(discovery.summary.skippedJsFiles, 1);
  });
  withRepo({
    "package.json": JSON.stringify({ name: "j" }),
    "index.js": "module.exports = 1;\n",
    "lib.mjs": "export const x = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.includedJs, true, "pure-JS repo (no tsconfig, no TS source) includes .js");
    assert.ok(discovery.sourceFiles.includes("index.js"));
    assert.equal(discovery.summary.skippedJsFiles, 0);
  });
});

test("excludes *.spec.*, __tests__/, __mocks__/, *.bench.*", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "m" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/index.spec.ts": "1;\n",
    "src/foo.test.ts": "1;\n",
    "src/bar.bench.ts": "1;\n",
    "src/__tests__/z.ts": "1;\n",
    "src/__mocks__/m.ts": "1;\n",
  }, dir => {
    assert.deepEqual(discoverRepository(dir).sourceFiles, ["src/index.ts"]);
  });
});

test("skips fixture/example/playground/e2e members with a summary count; --include-members overrides", () => {
  const files = {
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'playground/*'\n",
    "package.json": JSON.stringify({ name: "root" }),
    "tsconfig.json": "{}",
    "packages/core/package.json": JSON.stringify({ name: "@x/core" }),
    "packages/core/src/index.ts": "export const x = 1;\n",
    "playground/demo/package.json": JSON.stringify({ name: "demo" }),
    "playground/demo/src/app.ts": "export const y = 1;\n",
  };
  withRepo(files, dir => {
    const discovery = discoverRepository(dir);
    assert.ok(discovery.units.some(unit => unit.dir === "packages/core"), "real member kept");
    assert.ok(!discovery.units.some(unit => unit.dir === "playground/demo"), "playground member skipped");
    assert.deepEqual(discovery.summary.skippedMembers, ["playground/demo"]);
    assert.ok(!discovery.sourceFiles.includes("playground/demo/src/app.ts"), "fixture files dropped");

    const included = discoverRepository(dir, { includeAllMembers: true });
    assert.ok(included.units.some(unit => unit.dir === "playground/demo"), "--include-members scans it");
    assert.equal(included.summary.skippedMembers.length, 0);
  });
});

test("system name derives from root package.json name (fix 6)", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "cool-lib" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
  }, dir => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    const artifacts = scanRepository(dir);
    assert.equal(artifacts.snapshot.entities.find(entity => entity.kind === "softwareSystem")?.name, "cool-lib");
  });
});

/** Writes a plain (non-git) directory tree — the shape an extracted tarball has (no .git). */
function withTree(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "okie-scan-tree-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const full = join(dir, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function comparableDiscovery(discovery: ReturnType<typeof discoverRepository>) {
  return {
    sourceFiles: discovery.sourceFiles,
    units: discovery.units,
    unitByFile: [...discovery.unitByFile.entries()].sort(),
    unitByPackageName: [...discovery.unitByPackageName.entries()].sort(),
    summary: discovery.summary,
  };
}

test("tarball walk (discoverExtractedTree) equals git discovery on identical content — provider parity", () => {
  // A workspace repo exercising members, tooling (a non-member script), and a Rust crate.
  const files = {
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    "package.json": JSON.stringify({ name: "root" }),
    "tsconfig.json": "{}",
    "apps/web/package.json": JSON.stringify({ name: "@x/web" }),
    "apps/web/src/main.tsx": "export const App = 1;\n",
    "packages/core/package.json": JSON.stringify({ name: "@x/core" }),
    "packages/core/src/index.ts": "export const x = 1;\n",
    "scripts/build.mjs": "export const build = 1;\n",
    "crates/engine/Cargo.toml": "[package]\nname = \"engine\"\n",
    "crates/engine/src/lib.rs": "pub fn f() {}\n",
  };
  withRepo(files, dir => {
    // Same directory: git sees tracked files; the walk skips .git and sees the same set.
    assert.deepEqual(comparableDiscovery(discoverExtractedTree(dir)), comparableDiscovery(discoverRepository(dir)));
    const tarball = discoverExtractedTree(dir);
    assert.ok(tarball.units.some(unit => unit.dir === "apps/web"), "member from tarball walk");
    assert.ok(tarball.units.some(unit => unit.kind === "tooling"), "tooling from tarball walk");
    assert.ok(tarball.units.some(unit => unit.kind === "rust" && unit.dir === "crates/engine"), "rust crate from tarball walk");
  });
});

test("tarball walk applies the same extension/exclusion filters and skips node_modules", () => {
  withTree({
    "package.json": JSON.stringify({ name: "lib" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/index.spec.ts": "1;\n",
    "src/legacy.js": "module.exports = 1;\n",
    "dist/index.js": "1;\n",
    "types.d.ts": "export {};\n",
    "node_modules/dep/index.ts": "export const dep = 1;\n",
  }, dir => {
    const discovery = discoverExtractedTree(dir);
    assert.deepEqual(discovery.sourceFiles, ["src/index.ts"]);
    assert.equal(discovery.summary.skippedJsFiles, 1, ".js counted, not silently dropped");
    assert.ok(!discovery.sourceFiles.some(f => f.startsWith("node_modules/")), "node_modules never walked");
  });
});

test("tarball walk supports a single-package (non-workspace) repo", () => {
  withTree({
    "package.json": JSON.stringify({ name: "solo" }),
    "tsconfig.json": "{}",
    "index.ts": "export const x = 1;\n",
  }, dir => {
    const discovery = discoverExtractedTree(dir);
    assert.equal(discovery.summary.singlePackage, true);
    assert.equal(discovery.units.find(unit => unit.kind === "root")?.name, "solo");
    assert.deepEqual(discovery.sourceFiles, ["index.ts"]);
  });
});
