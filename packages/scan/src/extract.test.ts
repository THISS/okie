import assert from "node:assert/strict";
import test from "node:test";
import { validateArchitectureExtraction } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import {
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
