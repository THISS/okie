import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePortableAtlas, type PortableAtlas } from "@okie/architecture";
import { analyzeTypeScript } from "./analyze-typescript.js";
import { externalCargoSymbol, rustSymbolDisplay } from "./analyze-rust.js";
import { runConsumersQuery } from "./consumers-cli.js";
import {
  buildDependencyFacts, npmDependencyOfSpecifier, parseCargoLock, parseCargoManifest, parsePackageLock,
  parsePnpmLockImporters, parseYarnLock, redactSpec, rustImportRoots, typeScriptImports, type DependencyFactsInput,
} from "./dependency-facts.js";
import type { LanguageAnalysis } from "./language-analysis.js";
import { stableJson } from "./scan.js";

const SHA = "a".repeat(40);
const reader = (files: Record<string, string>) => (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
};
const facts = (files: Record<string, string>, extra: Partial<DependencyFactsInput> = {}) => buildDependencyFacts({
  commitSha: SHA, sourceFiles: Object.keys(files).filter(path => /\.(rs|[cm]?[jt]sx?)$/.test(path)), readFile: reader(files), analysisMode: "quick", ...extra,
});

test("pnpm lock importers parse v9/v6 nested entries and the v5 single-project layout", () => {
  const v9 = [
    "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    devDependencies:", "      typescript:", "        specifier: ^5.8.3", "        version: 5.9.3",
    "  apps/web:", "    dependencies:", "      '@okie/lib':", "        specifier: workspace:*", "        version: link:../../packages/lib",
    "      react-dom:", "        specifier: ^19", "        version: 19.2.7(react@19.2.7)", "", "packages:", "", "  react@19.2.7:", "    resolution: {integrity: x}",
  ].join("\n");
  const importers = parsePnpmLockImporters(v9);
  assert.equal(importers.get(".")?.get("typescript"), "5.9.3");
  assert.equal(importers.get("apps/web")?.get("react-dom"), "19.2.7");
  assert.equal(importers.get("apps/web")?.get("@okie/lib"), "link:../../packages/lib");
  const v5 = ["lockfileVersion: 5.4", "", "specifiers:", "  lodash: ^4.0.0", "", "dependencies:", "  lodash: 4.17.21", "", "packages:", "  /lodash/4.17.21:", "    dev: false"].join("\n");
  assert.equal(parsePnpmLockImporters(v5).get(".")?.get("lodash"), "4.17.21");
});

test("package-lock, yarn v1 and Cargo.lock parsers", () => {
  const lock = parsePackageLock(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/react": { version: "18.2.0" }, "packages/app/node_modules/react": { version: "17.0.2" }, "node_modules/@x/lib": { resolved: "packages/lib", link: true } } }));
  assert.equal(lock.get("packages/app/node_modules/react")?.version, "17.0.2");
  assert.equal(lock.get("node_modules/@x/lib")?.link, true);
  const yarn = parseYarnLock(['# yarn lockfile v1', '', '"react@^18.0.0", react@^18.2.0:', '  version "18.2.0"', '  resolved "https://registry/x"', '', "left-pad@1.3.0:", '  version "1.3.0"'].join("\n"));
  assert.equal(yarn.get("react@^18.0.0"), "18.2.0");
  assert.equal(yarn.get("react@^18.2.0"), "18.2.0");
  const cargo = parseCargoLock(['version = 4', '', '[[package]]', 'name = "app"', 'version = "0.1.0"', 'dependencies = [', ' "rand 0.8.5",', ' "serde",', ']', '', '[[package]]', 'name = "rand"', 'version = "0.8.5"', 'source = "registry+x"'].join("\n"));
  assert.deepEqual(cargo.map(item => [item.name, item.version, item.dependencies]), [["app", "0.1.0", ["rand 0.8.5", "serde"]], ["rand", "0.8.5", []]]);
});

test("Cargo.toml: target-specific, renamed, dotted, subsection and workspace-inherited dependencies", () => {
  const manifest = parseCargoManifest([
    "[package]", 'name = "gpu"', "version.workspace = true", "",
    "[dependencies]", 'core-lib = { path = "../core" }', 'json = { package = "serde_json", version = "1.0" }', "thiserror.workspace = true", 'rand = "0.8"', "",
    "[target.'cfg(target_arch = \"wasm32\")'.dependencies]", 'web-sys = { version = "=0.3.99", features = ["Window"] }', "",
    "[dev-dependencies.pretty]", 'version = "1"', "features = [", '  "a",', "]", "",
    "[build-dependencies]", 'cc = { git = "https://user:secret@example.com/cc.git", tag = "v1" }',
  ].join("\n"));
  assert.equal(manifest.packageName, "gpu");
  const rows = manifest.entries.map(entry => [entry.key, entry.section, entry.target ?? "", entry.version ?? entry.path ?? entry.git ?? (entry.workspace ? "ws" : ""), entry.package ?? "", entry.line]);
  assert.deepEqual(rows, [
    ["core-lib", "dependencies", "", "../core", "", 6],
    ["json", "dependencies", "", "1.0", "serde_json", 7],
    ["thiserror", "dependencies", "", "ws", "", 8],
    ["rand", "dependencies", "", "0.8", "", 9],
    ["web-sys", "dependencies", 'cfg(target_arch = "wasm32")', "=0.3.99", "", 12],
    ["pretty", "dev-dependencies", "", "1", "", 14],
    ["cc", "build-dependencies", "", "https://user:secret@example.com/cc.git", "", 21],
  ]);
});

const cargoRepo: Record<string, string> = {
  "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nthiserror = "2.0"\n',
  "Cargo.lock": [
    "version = 4", "",
    "[[package]]", 'name = "gpu"', 'version = "0.1.0"', "dependencies = [", ' "core-lib",', ' "rand 0.8.5",', ' "serde",', ' "serde_json",', ' "thiserror",', ' "wgpu",', "]", "",
    "[[package]]", 'name = "serde"', 'version = "1.0.228"', 'source = "registry+x"', 'dependencies = ["serde_core"]', "",
    "[[package]]", 'name = "serde_core"', 'version = "1.0.228"', 'source = "registry+x"', "",
    "[[package]]", 'name = "thiserror-impl"', 'version = "2.0.18"', 'source = "registry+x"', "",
    "[[package]]", 'name = "core-lib"', 'version = "0.1.0"', "",
    "[[package]]", 'name = "rand"', 'version = "0.7.3"', 'source = "registry+x"', "",
    "[[package]]", 'name = "rand"', 'version = "0.8.5"', 'source = "registry+x"', "",
    "[[package]]", 'name = "serde_json"', 'version = "1.0.1"', 'source = "registry+x"', 'dependencies = ["serde_core"]', "",
    "[[package]]", 'name = "thiserror"', 'version = "2.0.18"', 'source = "registry+x"', 'dependencies = ["thiserror-impl"]', "",
    "[[package]]", 'name = "wgpu"', 'version = "25.0.2"', 'source = "registry+x"', 'dependencies = ["wgpu-types", "thiserror"]', "",
    "[[package]]", 'name = "wgpu-types"', 'version = "25.0.0"', 'source = "registry+x"', "",
    "[[package]]", 'name = "ghost"', 'version = "1.0.0"', 'source = "registry+x"', "",
    "[[package]]", 'name = "ghost"', 'version = "2.0.0"', 'source = "registry+x"',
  ].join("\n"),
  "crates/gpu/Cargo.toml": [
    "[package]", 'name = "gpu"', "", "[dependencies]", 'core-lib = { path = "../core" }', 'json = { package = "serde_json", version = "1.0" }',
    "thiserror.workspace = true", 'rand = "0.8"', 'wgpu = "25"', 'ghost = ">=1"', 'serde = "1"',
  ].join("\n"),
  "crates/gpu/src/lib.rs": "use json::Value;\nuse ::wgpu::{Device, util::DeviceExt};\nuse crate::inner;\nuse std::fmt;\nextern crate rand as random;\nfn f() { let _ = thiserror::Error; }\n",
  "crates/core/Cargo.toml": '[package]\nname = "core-lib"\n',
  "crates/core/src/lib.rs": "pub fn x() {}\n",
};

test("Cargo declarations resolve through Cargo.lock: single, disambiguated by the crate entry, ambiguous, local, workspace", () => {
  const result = facts(cargoRepo);
  const byName = new Map(result.declarations.map(row => [row.dependency, row]));
  assert.equal(byName.get("core-lib")?.resolution, "local");
  assert.equal(byName.get("core-lib")?.local, true);
  assert.deepEqual([byName.get("serde_json")?.alias, byName.get("serde_json")?.resolvedVersions], ["json", ["1.0.1"]]);
  assert.deepEqual([byName.get("thiserror")?.workspaceInherited, byName.get("thiserror")?.requested, byName.get("thiserror")?.resolvedVersions], [true, "2.0", ["2.0.18"]]);
  assert.deepEqual([byName.get("rand")?.resolution, byName.get("rand")?.resolvedVersions], ["resolved", ["0.8.5"]], "crate lock entry selects one of two versions");
  assert.deepEqual([byName.get("ghost")?.resolution, byName.get("ghost")?.resolvedVersions], ["ambiguous", ["1.0.0", "2.0.0"]]);
  assert.match(byName.get("ghost")!.reason!, /2 candidate versions/);
  assert.deepEqual(result.packages.map(row => [row.ecosystem, row.name, row.manifestPath]), [["cargo", "core-lib", "crates/core/Cargo.toml"], ["cargo", "gpu", "crates/gpu/Cargo.toml"]]);
  // Rust imports honour renames, `::` absolute paths and extern crate aliases; crate/std are skipped.
  assert.deepEqual(result.imports.map(row => [row.dependency, row.kind, row.startLine, row.specifier]), [
    ["serde_json", "use", 1, "json::Value"],
    ["wgpu", "use", 2, "::wgpu::{Device, util::DeviceExt}"],
    ["rand", "externCrate", 5, "extern crate rand as random"],
  ]);
});

test("npm declarations: pnpm importer lookup, workspace/link locals, aliases, peers and credential redaction", () => {
  const result = facts({
    "package.json": JSON.stringify({ name: "root", devDependencies: { typescript: "^5.8.3" } }, null, 2),
    "pnpm-lock.yaml": ["lockfileVersion: '9.0'", "importers:", "  .:", "    devDependencies:", "      typescript:", "        specifier: ^5.8.3", "        version: 5.9.3",
      "  apps/web:", "    dependencies:", "      '@x/lib':", "        specifier: workspace:*", "        version: link:../../packages/lib",
      "      preact:", "        specifier: npm:react@^18", "        version: react@18.2.0", "packages:"].join("\n"),
    "apps/web/package.json": JSON.stringify({ name: "@x/web", dependencies: { "@x/lib": "workspace:*", preact: "npm:react@^18", secret: "git+https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y.git" }, peerDependencies: { vue: "*" } }, null, 2),
    "apps/web/src/a.ts": "import { h } from 'preact';\nimport type { T } from '@x/lib';\nexport * from '@x/lib/sub';\nimport fs from 'node:fs';\nimport path from 'path';\nimport rel from './rel';\nconst lazy = () => import('secret/deep');\nconst req = require('left-pad');\nimport old = require('old-lib');\nexport type { U } from 'types-only';\n",
  });
  const byKey = new Map(result.declarations.map(row => [`${row.declaringPackage}:${row.alias ?? row.dependency}`, row]));
  assert.deepEqual(byKey.get("package.json:typescript")?.resolvedVersions, ["5.9.3"]);
  assert.equal(byKey.get("package.json:typescript")?.source.line, 4);
  assert.equal(byKey.get("apps/web/package.json:@x/lib")?.resolution, "local");
  assert.deepEqual([byKey.get("apps/web/package.json:preact")?.dependency, byKey.get("apps/web/package.json:preact")?.resolvedVersions], ["react", ["18.2.0"]]);
  assert.match(byKey.get("apps/web/package.json:vue")!.reason!, /Peer dependency/);
  const secret = byKey.get("apps/web/package.json:secret")!;
  assert.doesNotMatch(secret.requested, /ghp_|user:/);
  assert.match(secret.requested, /\[redacted\]@github\.com/);
  assert.equal(secret.resolution, "unresolved");
  assert.deepEqual(result.imports.map(row => [row.dependency, row.specifier, row.kind, row.typeOnly]), [
    ["react", "preact", "static", false],
    ["@x/lib", "@x/lib", "static", true],
    ["@x/lib", "@x/lib/sub", "reexport", false],
    ["secret", "secret/deep", "dynamic", false],
    ["left-pad", "left-pad", "require", false],
    ["old-lib", "old-lib", "require", false],
    ["types-only", "types-only", "reexport", true],
  ]);
  assert.ok(result.imports.every(row => row.consumingPackage === "apps/web/package.json"));
});

test("package-lock nested workspace paths resolve nearest node_modules; yarn by descriptor", () => {
  const lockFacts = facts({
    "package.json": JSON.stringify({ name: "root", dependencies: { react: "^18" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/react": { version: "18.2.0" }, "packages/app/node_modules/react": { version: "17.0.2" }, "node_modules/lodash": { version: "4.17.21" } } }),
    "packages/app/package.json": JSON.stringify({ name: "app", dependencies: { react: "^17", lodash: "^4" } }),
    "packages/app/index.ts": "import 'react';",
  });
  assert.deepEqual(lockFacts.declarations.map(row => [row.declaringPackage, row.dependency, row.resolvedVersions[0]]), [
    ["packages/app/package.json", "lodash", "4.17.21"], ["package.json", "react", "18.2.0"], ["packages/app/package.json", "react", "17.0.2"],
  ]);
  const yarnFacts = facts({
    "package.json": JSON.stringify({ name: "root", dependencies: { react: "^18.0.0", missing: "^1" } }),
    "yarn.lock": '"react@^18.0.0":\n  version "18.3.1"\n',
    "index.ts": "import 'react';",
  });
  assert.deepEqual(yarnFacts.declarations.map(row => [row.dependency, row.resolution, row.resolvedVersions.join()]), [["missing", "unresolved", ""], ["react", "resolved", "18.3.1"]]);
});

test("specifier and import helpers skip builtins, relative, URL and virtual modules", () => {
  for (const specifier of ["node:fs", "fs", "fs/promises", "./x", "../x", "/abs", "#internal", "virtual:x", "https://cdn/x.js"]) assert.equal(npmDependencyOfSpecifier(specifier), undefined, specifier);
  assert.equal(npmDependencyOfSpecifier("@scope/pkg/sub"), "@scope/pkg");
  assert.deepEqual(typeScriptImports("a.ts", "export type { X } from 'x';\nimport type Y from 'y';").map(row => row.typeOnly), [true, true]);
  assert.deepEqual(rustImportRoots("use {serde::Serialize, self::x, super::y};\nuse a::*;\n").map(row => row.root), ["serde", "a"]);
  assert.equal(redactSpec("git+ssh://git@github.com/x/y.git"), "git+ssh://git@github.com/x/y.git");
  assert.equal(redactSpec("https://tok:x@host/p"), "https://[redacted]@host/p");
});

function syntheticAnalysis(externalReferences: NonNullable<LanguageAnalysis["externalReferences"]>): LanguageAnalysis {
  return {
    schemaVersion: 1, definitions: [], references: [], modules: [], externalReferences,
    coverage: [
      { language: "typescript", tool: "typescript", version: "5.9.3", coverage: "semantic", indexedFiles: [], limitations: ["Installed dependency types reused read-only from the local checkout after matching committed manifests and lockfiles; installation contents are not verified against the lockfile.", "x.ts: TS2307: Cannot find module 'gone'"] },
      { language: "rust", tool: "rust-analyzer", version: "1.87.0", coverage: "semantic", indexedFiles: [], limitations: [] },
    ],
  };
}

test("Rust SCIP symbols: classification, display and attribution of re-exports through Cargo.lock", () => {
  const firstParty = new Set(["gpu", "core-lib"]);
  assert.equal(externalCargoSymbol("rust-analyzer cargo std https://github.com/rust-lang/rust/library/std f32/impl#[f32]round().", firstParty), undefined);
  assert.equal(externalCargoSymbol("rust-analyzer cargo gpu 0.1.0 surface/Surface#", firstParty), undefined);
  assert.equal(externalCargoSymbol("rust-analyzer cargo wgpu 25.0.2 crate/", firstParty), undefined);
  assert.deepEqual(externalCargoSymbol("rust-analyzer cargo wgpu 25.0.2 api/device/Device#create_buffer().", firstParty),
    { crate: "wgpu", version: "25.0.2", display: "wgpu::api::device::Device::create_buffer" });
  assert.equal(rustSymbolDisplay("wgpu-types", "Color#"), "wgpu_types::Color");
  assert.equal(rustSymbolDisplay("x", "impl#[Foo]bar(+1)."), "x::impl<Foo>::bar");
  const at = (line: number) => ({ path: "crates/gpu/src/lib.rs", startLine: line, endLine: line, ecosystem: "cargo" as const, analyzer: "rust-analyzer@1.87.0" });
  const result = facts(cargoRepo, {
    analysisMode: "full",
    languageAnalysis: syntheticAnalysis([
      { ...at(2), package: "wgpu", version: "25.0.2", symbol: "wgpu::Device::create_buffer", kind: "calls" },
      { ...at(2), package: "wgpu-types", version: "25.0.0", symbol: "wgpu_types::Color", kind: "uses" },
      { ...at(1), package: "serde_json", version: "1.0.1", symbol: "serde_json::Value", kind: "uses" },
      { ...at(6), package: "orphan-crate", version: "9.9.9", symbol: "orphan_crate::X", kind: "uses" },
      { ...at(7), package: "thiserror-impl", version: "2.0.18", symbol: "thiserror_impl::Error", kind: "uses" },
      { ...at(8), package: "serde_core", version: "1.0.228", symbol: "serde_core::Serialize", kind: "uses" },
    ]),
  });
  assert.deepEqual(result.symbolReferences.map(row => [row.startLine, row.dependency, row.via ?? "", row.resolvedVersion ?? "", row.kind]), [
    [1, "serde_json", "", "1.0.1", "uses"],
    [2, "wgpu", "", "25.0.2", "calls"],
    [2, "wgpu", "wgpu-types", "25.0.2", "uses"],
    [6, "orphan-crate", "", "9.9.9", "uses"],
    [7, "thiserror", "thiserror-impl", "2.0.18", "uses"], // depth 1 via thiserror beats depth 2 via wgpu
    [8, "serde", "serde_core", "1.0.228", "uses"], // serde and serde_json tie at depth 1; facade naming picks serde
  ]);
  const rust = result.coverage.find(row => row.ecosystem === "cargo" && row.evidence === "symbolReferences")!;
  assert.equal(rust.status, "partial");
  assert.ok(rust.limitations.some(line => line.includes("1 reference(s) to transitive crates could not be attributed")), rust.limitations.join("\n"));
});

test("quick scans record symbol references as unavailable per ecosystem; full scans state the TS installation limit", () => {
  const quick = facts(cargoRepo);
  const cargo = quick.coverage.find(row => row.ecosystem === "cargo" && row.evidence === "symbolReferences")!;
  assert.equal(cargo.status, "unavailable");
  assert.match(cargo.limitations.join(" "), /rust-analyzer not run \(quick scan\)/);
  const full = facts({ "package.json": '{"name":"a"}', "a.ts": "import 'x';" }, { analysisMode: "full", languageAnalysis: syntheticAnalysis([]) });
  const npm = full.coverage.find(row => row.ecosystem === "npm" && row.evidence === "symbolReferences")!;
  assert.equal(npm.status, "partial");
  assert.ok(npm.limitations.some(line => /installed dependency type declarations/.test(line)));
  assert.ok(npm.limitations.some(line => /Installed dependency types reused/.test(line)));
  assert.ok(npm.limitations.some(line => /1 unresolved module/.test(line)));
});

test("caps are deterministic and truncation counts are recorded per dependency", () => {
  const refs = Array.from({ length: 7 }, (_, index) => ({ path: "a.ts", startLine: index + 1, endLine: index + 1, ecosystem: "npm" as const, package: "react", symbol: `s${index}`, kind: "uses" as const, analyzer: "typescript@5" }));
  const files = { "package.json": '{"name":"a","dependencies":{"react":"1","vue":"1"}}', "a.ts": "import 'react';\nimport 'vue';\nimport 'react/x';\n" };
  const result = facts(files, { analysisMode: "full", languageAnalysis: syntheticAnalysis(refs), limits: { maxImports: 2, maxSymbolReferencesPerDependencyFile: 3, maxSymbolReferences: 2 } });
  assert.deepEqual(result.imports.map(row => row.specifier), ["react", "vue"]);
  assert.deepEqual(result.symbolReferences.map(row => row.symbol), ["s0", "s1"]);
  const imports = result.coverage.find(row => row.ecosystem === "npm" && row.evidence === "imports")!;
  assert.deepEqual([imports.status, imports.dropped, imports.droppedByDependency], ["partial", 1, [{ dependency: "react", dropped: 1 }]]);
  const symbols = result.coverage.find(row => row.ecosystem === "npm" && row.evidence === "symbolReferences")!;
  assert.deepEqual([symbols.dropped, symbols.droppedByDependency], [5, [{ dependency: "react", dropped: 5 }]]);
  assert.ok(symbols.limitations.some(line => line.includes("Capped at 3 references per dependency per file")));
});

test("facts are byte-identical across shuffled discovery and reference order", () => {
  const files = { ...cargoRepo, "package.json": '{"name":"a","dependencies":{"react":"1"}}', "web/a.ts": "import 'react';", "web/b.tsx": "import 'react/jsx-runtime';" };
  const refs: NonNullable<LanguageAnalysis["externalReferences"]> = [
    { path: "web/a.ts", startLine: 1, endLine: 1, ecosystem: "npm", package: "react", symbol: "x", kind: "uses", analyzer: "typescript@5" },
    { path: "crates/gpu/src/lib.rs", startLine: 2, endLine: 2, ecosystem: "cargo", package: "wgpu", version: "25.0.2", symbol: "wgpu::A", kind: "calls", analyzer: "rust-analyzer@1" },
    { path: "web/b.tsx", startLine: 1, endLine: 1, ecosystem: "npm", package: "react", symbol: "y", kind: "calls", analyzer: "typescript@5" },
  ];
  const sources = Object.keys(files).filter(path => /\.(rs|tsx?)$/.test(path));
  const canonical = stableJson(buildDependencyFacts({ commitSha: SHA, sourceFiles: sources, readFile: reader(files), analysisMode: "full", languageAnalysis: syntheticAnalysis(refs) }));
  for (let seed = 0; seed < 6; seed += 1) {
    const rotate = <T>(items: readonly T[]): T[] => [...items.slice(seed % items.length), ...items.slice(0, seed % items.length)].reverse();
    const output = stableJson(buildDependencyFacts({ commitSha: SHA, sourceFiles: rotate(sources), readFile: reader(files), analysisMode: "full", languageAnalysis: syntheticAnalysis(rotate(refs)) }));
    assert.equal(output, canonical, `seed ${seed}`);
  }
});

function fixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "okie-deps-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("TypeScript analyzer emits external references for installed declarations, mapping @types and skipping workspace/builtin/lib", () => {
  const repo = fixture({
    "package.json": '{"name":"app","dependencies":{"pkg":"1","typed":"1","@x/lib":"workspace:*"}}',
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[]},"include":["src/**/*.ts"]}',
    "node_modules/pkg/package.json": '{"name":"pkg","types":"index.d.ts"}',
    "node_modules/pkg/index.d.ts": "export declare function helper(value: number): number;\nexport interface Options { size: number }\nexport declare namespace nested { function deep(): void }\n",
    "node_modules/typed/package.json": '{"name":"typed"}',
    "node_modules/@types/typed/package.json": '{"name":"@types/typed","types":"index.d.ts"}',
    "node_modules/@types/typed/index.d.ts": "export declare const value: string;\n",
    "src/main.ts": "import { helper, type Options, nested } from 'pkg';\nimport { value } from 'typed';\nexport function run(options: Options): number { nested.deep(); const n = [1].map(x => x); return helper(options.size) + value.length + n.length; }\n",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const rows = (analysis.externalReferences ?? []).map(row => [row.path, row.startLine, row.package, row.via ?? "", row.symbol, row.kind, row.typeOnly]);
    assert.deepEqual(rows, [
      ["src/main.ts", 3, "pkg", "", "Options", "uses", true],
      ["src/main.ts", 3, "pkg", "", "nested.deep", "calls", false],
      ["src/main.ts", 3, "pkg", "", "helper", "calls", false],
      ["src/main.ts", 3, "pkg", "", "Options.size", "uses", true],
      ["src/main.ts", 3, "typed", "@types/typed", "value", "uses", false],
    ], JSON.stringify(analysis.externalReferences, null, 1));
    assert.ok((analysis.externalReferences ?? []).every(row => row.analyzer.startsWith("typescript@")));
    assert.deepEqual(analysis, analyzeTypeScript(repo.root));
  } finally { repo.cleanup(); }
});

function portableFixture(dependencies?: PortableAtlas["dependencies"]): string {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), "utf8")
    .replaceAll("golden-worktree-okie-2026-07-14-v1", SHA));
  const bundle: PortableAtlas = { format: "okie-atlas", version: 1, repository: { commitSha: SHA, treeHash: "b".repeat(40) },
    snapshot: read("snapshot"), view: read("view"), story: read("story"), stories: [], analysis: { mode: "quick", adapters: [] },
    ...(dependencies ? { dependencies } : {}) };
  return JSON.stringify(bundle);
}

test("consumers CLI: text and JSON output, zero consumers is success, bad input fails", () => {
  const dependencies = facts(cargoRepo);
  const dir = mkdtempSync(join(tmpdir(), "okie-consumers-"));
  try {
    const bundlePath = join(dir, "atlas.okie.json");
    writeFileSync(bundlePath, portableFixture(dependencies));
    parsePortableAtlas(readFileSync(bundlePath, "utf8"));
    const text = runConsumersQuery(["wgpu", "--bundle", bundlePath]);
    assert.match(text, /^Consumers of wgpu \[cargo\]/);
    assert.match(text, /crates\/gpu\/src\/lib\.rs:2 {2}use {2}'::wgpu::\{Device, util::DeviceExt\}'/);
    assert.match(text, /Coverage limits\n[\s\S]*rust-analyzer not run \(quick scan\)/);
    const json = JSON.parse(runConsumersQuery(["serde-json", "--bundle", bundlePath, "--json", "--ecosystem", "cargo"]));
    assert.deepEqual(json.matchedNames, ["serde_json"]);
    assert.equal(json.consumers[0].package.name, "gpu");
    assert.throws(() => runConsumersQuery(["wgpu"]), /--bundle/);
    assert.throws(() => runConsumersQuery(["wgpu", "--bundle", bundlePath, "--ecosystem", "pip"]), /npm or cargo/);
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const none = spawnSync(process.execPath, [cli, "consumers", "left-pad", "--bundle", bundlePath], { encoding: "utf8" });
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /0 consuming package\(s\)/);
    const oldBundle = join(dir, "old.okie.json");
    writeFileSync(oldBundle, portableFixture());
    const old = spawnSync(process.execPath, [cli, "consumers", "wgpu", "--bundle", oldBundle], { encoding: "utf8" });
    assert.equal(old.status, 0, old.stderr);
    assert.match(old.stdout, /predates dependency capture/);
    const bad = spawnSync(process.execPath, [cli, "consumers", "wgpu", "--bundle", join(dir, "missing.json")], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Bundle not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
