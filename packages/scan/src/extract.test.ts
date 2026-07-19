import assert from "node:assert/strict";
import test from "node:test";
import { validateArchitectureExtraction } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import {
  cargoPathDependencies,
  extractArchitecture,
  moduleImports,
  parseSource,
  resolvePackageImport,
  resolveRelativeImport,
  topLevelDeclarations,
} from "./extract.js";

test("topLevelDeclarations captures every top-level named decl, exported or not", () => {
  const source = parseSource("m.ts", [
    "export function foo() {}",
    "interface Bar { x: number }",
    "export const baz = 1, qux = 2;",
    "type Alias = string;",
    "export class Cls {}",
    "enum E { A }",
    "function localHelper() { const inner = 1; return inner; }",
  ].join("\n"));
  assert.deepEqual(
    topLevelDeclarations(source).map(d => d.name),
    ["foo", "Bar", "baz", "qux", "Alias", "Cls", "E", "localHelper"],
  );
  // `inner` is nested, not top-level.
  assert.equal(topLevelDeclarations(source).some(d => d.name === "inner"), false);
});

test("topLevelDeclarations parses tsx and reports 1-based line spans", () => {
  const source = parseSource("C.tsx", "const A = 1;\nexport function C() {\n  return <div />;\n}\n");
  const decls = topLevelDeclarations(source);
  const c = decls.find(d => d.name === "C")!;
  assert.equal(c.startLine, 2);
  assert.equal(c.endLine, 4);
});

test("moduleImports collects import and re-export specifiers", () => {
  const source = parseSource("m.ts", [
    "import a from './a.js';",
    "import { b } from '../b.js';",
    "export { c } from './c.js';",
    "import 'side-effect';",
    "const dynamic = 1;",
  ].join("\n"));
  assert.deepEqual(moduleImports(source).map(i => i.specifier), ["./a.js", "../b.js", "./c.js", "side-effect"]);
});

test("resolveRelativeImport maps .js/.jsx/extensionless specifiers onto discovered files", () => {
  const files = new Set(["pkg/src/model.ts", "pkg/src/ui/View.tsx", "pkg/src/util/index.ts"]);
  assert.equal(resolveRelativeImport("pkg/src/validation.ts", "./model.js", files), "pkg/src/model.ts");
  assert.equal(resolveRelativeImport("pkg/src/app.ts", "./ui/View.js", files), "pkg/src/ui/View.tsx");
  assert.equal(resolveRelativeImport("pkg/src/app.ts", "./util", files), "pkg/src/util/index.ts");
  assert.equal(resolveRelativeImport("pkg/src/app.ts", "./missing.js", files), undefined);
});

test("resolvePackageImport maps @scope specifiers (incl subpaths) to member dirs", () => {
  const units = new Map([["@okie/architecture", "packages/architecture"], ["@okie/scene-compiler", "packages/scene-compiler"]]);
  assert.equal(resolvePackageImport("@okie/architecture", units), "packages/architecture");
  assert.equal(resolvePackageImport("@okie/architecture/sub", units), "packages/architecture");
  assert.equal(resolvePackageImport("react", units), undefined);
});

function syntheticDiscovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/b/src/main.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b" },
    ],
    unitByFile: new Map([["pkg/a/src/index.ts", "pkg/a"], ["pkg/b/src/main.ts", "pkg/b"]]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const syntheticFiles: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nimport './helper.js';\nexport class Beta {}\n",
};

function readSynthetic(path: string): string {
  const text = syntheticFiles[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
}

test("extractArchitecture emits a gate-clean document with C4 hierarchy and import relations", () => {
  const extraction = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile: readSynthetic,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);

  const byId = new Map(extraction.entities.map(e => [e.id, e]));
  assert.ok(byId.has("system:acme"));
  assert.equal(byId.get("system:acme")!.kind, "softwareSystem");
  assert.equal(byId.get("container:pkg-a")!.parentId, "system:acme");
  assert.equal(byId.get("component:pkg-a-src-index-ts")!.parentId, "container:pkg-a");
  // top-level decls become code entities with path+symbol+line anchors
  const alpha = byId.get("code:pkg-a-src-index-ts:alpha")!;
  assert.equal(alpha.parentId, "component:pkg-a-src-index-ts");
  assert.equal(alpha.sourceRefs[0]!.symbol, "alpha");
  assert.equal(alpha.sourceRefs[0]!.startLine, 1);

  // @acme/a import → container→container dependsOn; unresolved './helper.js' → no relation.
  assert.deepEqual(
    extraction.relations.map(r => [r.from, r.to, r.kind]),
    [["container:pkg-b", "container:pkg-a", "dependsOn"]],
  );
  assert.ok(extraction.relations[0]!.evidence.length >= 1);
});

test("extractArchitecture is independent of source-file order", () => {
  const base = syntheticDiscovery();
  const forward = extractArchitecture({ discovery: base, readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const reversed = extractArchitecture({
    discovery: { ...base, sourceFiles: [...base.sourceFiles].reverse() },
    readFile: readSynthetic,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test("topLevelDeclarations marks the export surface, including export-list and default forms", () => {
  const source = parseSource("m.ts", [
    "export function pub() {}",
    "function internalHelper() {}",
    "const secret = 1;",
    "const listed = 2;",
    "class DefaultThing {}",
    "export { listed };",
    "export default DefaultThing;",
  ].join("\n"));
  assert.deepEqual(
    topLevelDeclarations(source).map(d => [d.name, d.exported]),
    [["pub", true], ["internalHelper", false], ["secret", false], ["listed", true], ["DefaultThing", true]],
  );
});

test("topLevelDeclarations does not mark local names for re-exports from other modules", () => {
  const source = parseSource("m.ts", [
    "const shadow = 1;",
    "export { shadow } from './elsewhere.js';",
  ].join("\n"));
  // The re-export exports ANOTHER module's symbol; the local `shadow` stays private.
  assert.deepEqual(topLevelDeclarations(source).map(d => [d.name, d.exported]), [["shadow", false]]);
});

test("codeSurface 'public' keeps only exported declarations as code entities; default keeps all", () => {
  const files: Record<string, string> = {
    ...syntheticFiles,
    "pkg/a/src/index.ts": "export function alpha() {}\nfunction hidden() {}\nexport const A = 1;\n",
  };
  const readFile = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const everything = extractArchitecture({ discovery: syntheticDiscovery(), readFile, systemName: "Acme", systemSlug: "acme" });
  const publicOnly = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile,
    systemName: "Acme",
    systemSlug: "acme",
    codeSurface: "public",
  });
  assert.deepEqual(validateArchitectureExtraction(publicOnly), []);
  const codeNames = (extraction: typeof everything): string[] => extraction.entities
    .filter(entity => entity.kind === "code" && entity.parentId === "component:pkg-a-src-index-ts")
    .map(entity => entity.name)
    .sort();
  assert.deepEqual(codeNames(everything), ["A", "alpha", "hidden"]);
  assert.deepEqual(codeNames(publicOnly), ["A", "alpha"]);
  // The file component itself survives either way — only private symbols fold into it.
  assert.ok(publicOnly.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"));
});

function symbolDiscovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/a.ts", "pkg/a/src/b.ts"],
    units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" }],
    unitByFile: new Map([["pkg/a/src/a.ts", "pkg/a"], ["pkg/a/src/b.ts", "pkg/a"]]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const symbolFiles: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/a.ts": [
    "export function alpha() { return helper(); }",
    "export function gamma() {}",
    "function helper() { return 1; }",
  ].join("\n"),
  "pkg/a/src/b.ts": [
    "import { alpha as al } from './a.js';",
    "export function beta() { return al() + al(); }",
    "export function delta(input: { alpha: number }) { return input.alpha; }",
    "export const shorthand = { al };",
  ].join("\n"),
};

const readSymbolFile = (path: string): string => {
  const text = symbolFiles[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

test("symbol pass derives same-file and named-import code→code 'uses' relations with reference evidence", () => {
  const extraction = extractArchitecture({
    discovery: symbolDiscovery(),
    readFile: readSymbolFile,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const uses = extraction.relations.filter(relation => relation.kind === "uses");
  const pairs = uses.map(relation => [relation.from, relation.to]);
  // Same-file: alpha → helper. Cross-file: beta and shorthand → alpha (through the alias).
  assert.deepEqual(pairs.sort(), [
    ["code:pkg-a-src-a-ts:alpha", "code:pkg-a-src-a-ts:helper"],
    ["code:pkg-a-src-b-ts:beta", "code:pkg-a-src-a-ts:alpha"],
    ["code:pkg-a-src-b-ts:shorthand", "code:pkg-a-src-a-ts:alpha"],
  ].sort());
  // `input.alpha` (property access) and the parameter binding never count as references.
  assert.ok(!pairs.some(([from]) => from === "code:pkg-a-src-b-ts:delta"));
  // beta references al twice on one line → evidence dedups to the reference site.
  const beta = uses.find(relation => relation.from === "code:pkg-a-src-b-ts:beta")!;
  assert.equal(beta.evidence[0]!.source.path, "pkg/a/src/b.ts");
  assert.equal(beta.evidence[0]!.source.startLine, 2);
});

test("public surface drops relations whose endpoint folded away, keeping the public↔public graph", () => {
  const extraction = extractArchitecture({
    discovery: symbolDiscovery(),
    readFile: readSymbolFile,
    systemName: "Acme",
    systemSlug: "acme",
    codeSurface: "public",
  });
  const uses = extraction.relations.filter(relation => relation.kind === "uses");
  const pairs = uses.map(relation => [relation.from, relation.to]);
  // helper is private → alpha→helper disappears; the public cross-file edges stay.
  assert.deepEqual(pairs.sort(), [
    ["code:pkg-a-src-b-ts:beta", "code:pkg-a-src-a-ts:alpha"],
    ["code:pkg-a-src-b-ts:shorthand", "code:pkg-a-src-a-ts:alpha"],
  ].sort());
});

test("symbol relations are independent of source-file order", () => {
  const base = symbolDiscovery();
  const forward = extractArchitecture({ discovery: base, readFile: readSymbolFile, systemName: "Acme", systemSlug: "acme" });
  const reversed = extractArchitecture({
    discovery: { ...base, sourceFiles: [...base.sourceFiles].reverse() },
    readFile: readSymbolFile,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test("component names are container-relative while ids and evidence keep the full path", () => {
  const extraction = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile: readSynthetic,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const component = extraction.entities.find(entity => entity.id === "component:pkg-a-src-index-ts")!;
  assert.equal(component.name, "src/index.ts");
  assert.equal(component.sourceRefs[0]!.path, "pkg/a/src/index.ts");
});

test("a relative import escaping the discovered set maps to the owning unit as a container edge", () => {
  const discovery: Discovery = {
    sourceFiles: ["apps/web/src/adapter.ts"],
    units: [
      { kind: "member", dir: "apps/web", name: "@acme/web", packageName: "@acme/web", evidencePath: "apps/web" },
      { kind: "rust", dir: "crates/engine-wasm", name: "engine-wasm", evidencePath: "crates/engine-wasm" },
    ],
    unitByFile: new Map([["apps/web/src/adapter.ts", "apps/web"]]),
    unitByPackageName: new Map([["@acme/web", "apps/web"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "apps/web/src/adapter.ts": "import init from '../../../crates/engine-wasm/pkg/engine_wasm.js';\nexport const boot = init;\n",
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  const edge = extraction.relations.find(relation =>
    relation.from === "container:apps-web" && relation.to === "container:crates-engine-wasm");
  assert.ok(edge, "expected apps/web → crates/engine-wasm container edge from the escaped relative import");
  assert.equal(edge!.evidence[0]!.source.path, "apps/web/src/adapter.ts");
});

test("cargoPathDependencies reads inline tables, subsections, and target-scoped sections; skips dev deps", () => {
  const manifest = [
    "[package]",
    'name = "engine-wasm"',
    "",
    "[dependencies]",
    'engine-core = { path = "../engine-core" }',
    "serde.workspace = true",
    "",
    "[dependencies.protocol]",
    'path = "../protocol"',
    "",
    "[target.'cfg(target_arch = \"wasm32\")'.dependencies]",
    'bindgen-helper = { version = "1", path = "../bindgen-helper" }',
    "",
    "[dev-dependencies]",
    'test-util = { path = "../test-util" }',
  ].join("\n");
  assert.deepEqual(cargoPathDependencies(manifest).map(dep => [dep.name, dep.path]), [
    ["engine-core", "../engine-core"],
    ["protocol", "../protocol"],
    ["bindgen-helper", "../bindgen-helper"],
  ]);
});

test("Cargo path dependencies become container edges between crate units", () => {
  const discovery: Discovery = {
    sourceFiles: [],
    units: [
      { kind: "rust", dir: "crates/engine-wasm", name: "engine-wasm", evidencePath: "crates/engine-wasm" },
      { kind: "rust", dir: "crates/engine-core", name: "engine-core", evidencePath: "crates/engine-core" },
    ],
    unitByFile: new Map(),
    unitByPackageName: new Map(),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "crates/engine-wasm/Cargo.toml": '[dependencies]\nengine-core = { path = "../engine-core" }\n',
    "crates/engine-core/Cargo.toml": "[dependencies]\n",
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  const edge = extraction.relations.find(relation =>
    relation.from === "container:crates-engine-wasm" && relation.to === "container:crates-engine-core");
  assert.ok(edge, "expected engine-wasm → engine-core edge from Cargo path dependency");
  assert.equal(edge!.evidence[0]!.source.path, "crates/engine-wasm/Cargo.toml");
  assert.equal(edge!.evidence[0]!.source.startLine, 2);
});
