import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ARCHITECTURE_EXTRACTION_LIMITS,
  buildC4ProjectionBundle,
  validateArchitectureExtraction,
  type ArchitectureExtractionEntity,
} from "@okie/architecture";
import type { Discovery, SourceUnit } from "./discover.js";
import {
  MAX_EXTERNAL_SYSTEMS,
  extractArchitecture,
  packageNameOfSpecifier,
  runtimeDependencyLines,
} from "./extract.js";
import { stableJson } from "./scan.js";
import { scanRepository } from "./scan.js";

// ---------------------------------------------------------------------------
// Unit tests for the two pure helpers.
// ---------------------------------------------------------------------------

test("packageNameOfSpecifier collapses subpaths and scopes; ignores relative", () => {
  assert.equal(packageNameOfSpecifier("react"), "react");
  assert.equal(packageNameOfSpecifier("react-dom/client"), "react-dom");
  assert.equal(packageNameOfSpecifier("@scope/pkg"), "@scope/pkg");
  assert.equal(packageNameOfSpecifier("@fontsource/ibm-plex-sans/latin-400.css"), "@fontsource/ibm-plex-sans");
  assert.equal(packageNameOfSpecifier("node:fs"), "node:fs"); // dropped later by the allowlist, not here
  assert.equal(packageNameOfSpecifier("./local"), undefined);
  assert.equal(packageNameOfSpecifier("../up"), undefined);
  assert.equal(packageNameOfSpecifier("@scope"), undefined); // scope with no package name
});

test("runtimeDependencyLines anchors keys inside dependencies only (not devDependencies)", () => {
  const manifest = [
    "{",
    '  "name": "x",',
    '  "dependencies": {',
    '    "react": "^19.0.0",',
    '    "mermaid": "11.0.0"',
    "  },",
    '  "devDependencies": {',
    '    "react": "^19.0.0",',
    '    "typescript": "^5.0.0"',
    "  }",
    "}",
  ].join("\n");
  const lines = runtimeDependencyLines(manifest);
  assert.equal(lines.get("react"), 4, "react anchored to its dependencies line, not the devDependencies one");
  assert.equal(lines.get("mermaid"), 5);
  // typescript lives only under devDependencies -> not anchored as a runtime dep.
  assert.equal(lines.get("typescript"), undefined);
});

test("runtimeDependencyLines handles an empty single-line dependencies object", () => {
  const manifest = ['{', '  "dependencies": {},', '  "devDependencies": { "typescript": "^5" }', "}"].join("\n");
  const lines = runtimeDependencyLines(manifest);
  assert.equal(lines.get("typescript"), undefined, "devDependencies after an empty deps block are not captured");
  assert.equal(lines.size, 0);
});

// ---------------------------------------------------------------------------
// Synthetic repo fixture exercising selection, filtering, evidence, and relations.
// ---------------------------------------------------------------------------

const manifests: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", dependencies: {}, devDependencies: { typescript: "^5.0.0" } }, null, 2),
  "pkg/app/package.json": JSON.stringify({
    name: "@acme/app",
    dependencies: { react: "^19.0.0", "@scope/ui": "^2.0.0", rare: "^1.0.0", "@acme/lib": "workspace:*" },
    devDependencies: { eslint: "^9.0.0" },
  }, null, 2),
  "pkg/lib/package.json": JSON.stringify({ name: "@acme/lib", dependencies: { react: "^19.0.0" } }, null, 2),
};

const sourceFilesText: Record<string, string> = {
  // react x2 in app, @scope/ui x1, rare x1, workspace @acme/lib (unit edge), fs builtin,
  // relative import, typescript (devDep only -> excluded), eslint (devDep only -> excluded).
  "pkg/app/src/a.ts": [
    'import React from "react";',
    'import { X } from "@scope/ui";',
    'import { L } from "@acme/lib";',
    'import { readFile } from "fs";',
    'import "./b.js";',
    'import { rare } from "rare";',
    'import ts from "typescript";',
    'import lint from "eslint";',
    "export function a() {}",
  ].join("\n"),
  "pkg/app/src/b.ts": 'import React from "react";\nexport function b() {}\n',
  "pkg/lib/src/l.ts": 'import React from "react";\nexport function L() {}\n',
};

function syntheticDiscovery(): Discovery {
  const units: SourceUnit[] = [
    { kind: "member", dir: "pkg/app", name: "@acme/app", packageName: "@acme/app", evidencePath: "pkg/app" },
    { kind: "member", dir: "pkg/lib", name: "@acme/lib", packageName: "@acme/lib", evidencePath: "pkg/lib" },
  ];
  return {
    sourceFiles: ["pkg/app/src/a.ts", "pkg/app/src/b.ts", "pkg/lib/src/l.ts"],
    units,
    unitByFile: new Map([
      ["pkg/app/src/a.ts", "pkg/app"], ["pkg/app/src/b.ts", "pkg/app"], ["pkg/lib/src/l.ts", "pkg/lib"],
    ]),
    unitByPackageName: new Map([["@acme/app", "pkg/app"], ["@acme/lib", "pkg/lib"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const readSynthetic = (path: string): string => {
  const text = manifests[path] ?? sourceFilesText[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

function externals(entities: readonly ArchitectureExtractionEntity[]): ArchitectureExtractionEntity[] {
  return entities.filter(entity => entity.kind === "externalSystem");
}

test("emits externalSystems for declared runtime deps; excludes builtins/dev/workspace/undeclared", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  assert.deepEqual(validateArchitectureExtraction(extraction), [], "external emission must stay gate-clean");

  const names = externals(extraction.entities).map(entity => entity.name).sort();
  assert.deepEqual(names, ["@scope/ui", "rare", "react"], "only declared, imported, third-party runtime deps");

  // fs is a node builtin (undeclared), typescript+eslint are devDependencies only,
  // @acme/lib is a workspace package -> a container edge, never an external.
  for (const excluded of ["fs", "typescript", "eslint", "@acme/lib"]) {
    assert.ok(!names.includes(excluded), `${excluded} must not be an external system`);
  }
  // @acme/lib resolves to a container->container edge instead.
  const libId = extraction.entities.find(e => e.id === "external:acme-lib");
  assert.equal(libId, undefined, "no external:acme-lib entity");
});

test("external ids/kinds are gate-valid and top-level (no parentId)", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const react = externals(extraction.entities).find(entity => entity.name === "react")!;
  assert.equal(react.id, "external:react");
  assert.equal(react.kind, "externalSystem");
  assert.equal(react.parentId, undefined, "external systems are top-level context");
  const scoped = externals(extraction.entities).find(entity => entity.name === "@scope/ui")!;
  assert.equal(scoped.id, "external:scope-ui");
});

test("external evidence: manifest declaration line + real import sites, within limits", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const react = externals(extraction.entities).find(entity => entity.name === "react")!;
  const paths = react.sourceRefs.map(ref => ref.path);
  // declaration anchor(s) from the manifests where react is a runtime dep + the import sites.
  assert.ok(paths.includes("pkg/app/package.json"), "carries a package.json declaration anchor");
  assert.ok(paths.includes("pkg/app/src/a.ts") && paths.includes("pkg/app/src/b.ts") && paths.includes("pkg/lib/src/l.ts"),
    "carries the real import sites");
  // the manifest anchor has a concrete line number.
  const decl = react.sourceRefs.find(ref => ref.path === "pkg/app/package.json")!;
  assert.equal(typeof decl.startLine, "number");
  assert.ok(react.sourceRefs.length <= ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs);
});

test("relations attribute the dependency to the importing container (react from both app and lib)", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const byId = new Map(extraction.entities.map(e => [e.id, e]));
  const reactRels = extraction.relations.filter(r => r.to === "external:react");
  const froms = reactRels.map(r => r.from).sort();
  assert.deepEqual(froms, ["container:pkg-app", "container:pkg-lib"], "one edge per importing container");
  for (const relation of reactRels) {
    assert.equal(relation.kind, "dependsOn");
    assert.ok(relation.evidence.length >= 1 && relation.evidence.length <= ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems);
    assert.ok(byId.get(relation.from)?.kind === "container");
  }
  // the app carries two react import sites -> both retained as evidence.
  const appEdge = reactRels.find(r => r.from === "container:pkg-app")!;
  assert.equal(appEdge.evidence.length, 2);
});

test("selection keeps only the top-N by (import count desc, name asc)", () => {
  // Nine single-import third-party deps -> exactly MAX_EXTERNAL_SYSTEMS survive, name-sorted.
  const names = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
  const rootManifest = JSON.stringify({ name: "m", dependencies: Object.fromEntries(names.map(n => [n, "^1.0.0"])) }, null, 2);
  const src = names.map(n => `import x from "${n}";`).join("\n") + "\nexport const z = 1;\n";
  const read = (path: string): string => {
    if (path === "package.json") return rootManifest;
    if (path === "m/src/index.ts") return src;
    throw new Error(`missing ${path}`);
  };
  const discovery: Discovery = {
    sourceFiles: ["m/src/index.ts"],
    units: [{ kind: "member", dir: "m", name: "@m/m", packageName: "@m/m", evidencePath: "m" }],
    unitByFile: new Map([["m/src/index.ts", "m"]]),
    unitByPackageName: new Map([["@m/m", "m"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const extraction = extractArchitecture({ discovery, readFile: read, systemName: "M", systemSlug: "m" });
  const emitted = externals(extraction.entities).map(e => e.name).sort();
  assert.equal(emitted.length, MAX_EXTERNAL_SYSTEMS);
  assert.deepEqual(emitted, ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"], "p9 dropped as the lowest-ranked");
});

test("external emission is byte-identical across shuffled discovery order", () => {
  const base = syntheticDiscovery();
  const canonical = stableJson(extractArchitecture({ discovery: base, readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" }));
  const shuffles: Discovery[] = [
    { ...base, sourceFiles: [...base.sourceFiles].reverse(), units: [...base.units].reverse() },
    { ...base, sourceFiles: [base.sourceFiles[2]!, base.sourceFiles[0]!, base.sourceFiles[1]!] },
  ];
  for (const [index, discovery] of shuffles.entries()) {
    const output = stableJson(extractArchitecture({ discovery, readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" }));
    assert.equal(output, canonical, `external emission differs under shuffle ${index}`);
  }
});

// ---------------------------------------------------------------------------
// Real Okie scan: the obvious third parties surface with real import evidence and render at L1.
// ---------------------------------------------------------------------------

test("Okie scan gains externalSystems (react, mermaid, typescript...) with real import evidence", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { snapshot } = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });
  const ext = snapshot.entities.filter(entity => entity.kind === "externalSystem");
  const names = new Set(ext.map(entity => entity.name));

  for (const expected of ["react", "mermaid", "typescript"]) {
    assert.ok(names.has(expected), `expected external system ${expected}; saw ${[...names].sort().join(", ")}`);
  }
  // No first-party @okie/* package (e.g. the CSS-only @okie/theme workspace member) leaks in.
  assert.ok(![...names].some(name => name.startsWith("@okie/")), "no first-party @okie/* external systems");
  assert.ok(ext.length <= MAX_EXTERNAL_SYSTEMS);

  // typescript is attributed to the scanner container that imports it, with a real import site.
  const ts = ext.find(entity => entity.name === "typescript")!;
  assert.ok(ts.sourceRefs.some(ref => ref.path === "packages/scan/src/extract.ts"), "typescript cites its real import");
  const tsEdge = snapshot.relations.find(relation => relation.to === ts.id && relation.from === "container:packages-scan");
  assert.ok(tsEdge, "typescript is a dependency of the scan container");
});

test("Okie externalSystems render in the L1 context band as system-context nodes", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { snapshot } = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });
  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem")!;
  const bundle = buildC4ProjectionBundle(snapshot, { rootEntityId: system.id, focusEntityId: system.id, familyId: "view-family:okie:context-test" });
  const context = Object.values(bundle.projectionById).find(projection => projection.band === "context")!;

  const contextExternals = context.visualNodeIds
    .map(id => bundle.visualNodeById[id]!)
    .filter(node => node.kind === "externalSystem");
  assert.ok(contextExternals.length >= 1, "external systems appear as L1 context nodes");
  // At L1 the container->external edges collapse to system->external interactions.
  const systemToExternal = context.visualEdgeIds
    .map(id => bundle.visualEdgeById[id]!)
    .filter(edge => bundle.visualNodeById[edge.toVisualId]?.kind === "externalSystem"
      && bundle.visualNodeById[edge.fromVisualId]?.kind === "softwareSystem");
  assert.ok(systemToExternal.length >= 1, "the system interacts with external systems at L1");
});
