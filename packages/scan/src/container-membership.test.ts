import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parsePortableAtlas, serializePortableAtlas, type ArchitectureExtraction } from "@okie/architecture";
import { membershipDiagnostics } from "./container-membership.js";
import { discoverRepository, mostSpecificRoot, pureRelativeReexportSpecifiers, TOOLING_UNIT_KEY, type DiscoverOptions } from "./discover.js";
import { collectExtractedArchitecture } from "./extract.js";
import { portableAtlasFromScan } from "./portable.js";
import { buildScanArtifacts, scanRepository } from "./scan.js";

function withCommittedRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "okie-scan-membership-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [relative, content] of Object.entries(files)) {
      const full = join(dir, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

/** Full scan pipeline (buildScanArtifacts) over a working tree with explicit discovery options. */
function artifactsFor(dir: string, options: DiscoverOptions = {}) {
  return buildScanArtifacts({
    discovery: discoverRepository(dir, options),
    pin,
    readFile: path => readFileSync(join(dir, path), "utf8"),
    repositorySlug: "acme",
    systemName: "Acme",
  });
}

const WORKSPACE_BASE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme" }),
  "tsconfig.json": "{}",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
  "apps/web/package.json": JSON.stringify({ name: "@acme/web" }),
  "apps/web/src/main.ts": "export const main = 1;\n",
  "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
  "packages/core/src/util.ts": "export const util = 1;\n",
};

// The thiss/okie shape: an app-level `api/` folder plus root Vercel re-export shims.
const VERCEL_SHIM_REPO: Record<string, string> = {
  ...WORKSPACE_BASE,
  "apps/web/api/share.ts": "export default function share(): string { return 'share'; }\n",
  "apps/web/api/og.ts": "export default function og(): string { return 'og'; }\n",
  "api/share.ts": "export { default } from '../apps/web/api/share.ts';\n",
  "api/og.ts": "export { default } from \"../apps/web/api/og\";\n",
  "scripts/build.mjs": "export const build = () => 1;\n",
  "CODEOWNERS": "/api/ @edge\n/apps/web/ @web\n",
};

test("mostSpecificRoot: the deepest containing root wins regardless of order", () => {
  const dirs = ["apps/web", "apps/web/api", "apps/webby"];
  assert.equal(mostSpecificRoot("apps/web/api/share.ts", dirs), "apps/web/api");
  assert.equal(mostSpecificRoot("apps/web/api/share.ts", [...dirs].reverse()), "apps/web/api");
  assert.equal(mostSpecificRoot("apps/web/src/main.ts", dirs), "apps/web");
  assert.equal(mostSpecificRoot("apps/webby/x.ts", dirs), "apps/webby");
  assert.equal(mostSpecificRoot("api/share.ts", dirs), undefined);
});

test("pureRelativeReexportSpecifiers accepts only relative re-export-only modules", () => {
  assert.deepEqual(pureRelativeReexportSpecifiers("a.ts", "export { default } from '../x.ts';\n"), ["../x.ts"]);
  assert.deepEqual(pureRelativeReexportSpecifiers("a.ts", "// shim\nexport * from './x';\nexport { y as z } from './y';\n"), ["./x", "./y"]);
  assert.equal(pureRelativeReexportSpecifiers("a.ts", "export { default } from 'pkg';\n"), undefined, "bare specifier");
  assert.equal(pureRelativeReexportSpecifiers("a.ts", "import x from './x';\nexport default x;\n"), undefined, "import + default export");
  assert.equal(pureRelativeReexportSpecifiers("a.ts", "export { default } from './x';\nexport const y = 1;\n"), undefined, "has a declaration");
  assert.equal(pureRelativeReexportSpecifiers("a.ts", ""), undefined, "empty");
  assert.equal(pureRelativeReexportSpecifiers("a.rs", "pub use x;\n"), undefined, "non-JS");
});

test("nested workspace members: a file belongs to the most specific package root only", () => {
  withCommittedRepo({
    "package.json": JSON.stringify({ name: "acme" }),
    "tsconfig.json": "{}",
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - apps/web/api\n",
    "apps/web/package.json": JSON.stringify({ name: "@acme/web" }),
    "apps/web/src/main.ts": "export const main = 1;\n",
    "apps/web/api/package.json": JSON.stringify({ name: "@acme/web-api" }),
    "apps/web/api/share.ts": "export const share = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.unitByFile.get("apps/web/api/share.ts"), "apps/web/api");
    assert.equal(discovery.unitByFile.get("apps/web/src/main.ts"), "apps/web");
    assert.deepEqual(discovery.units.map(unit => unit.dir), ["apps/web", "apps/web/api"]);
    const extraction = collectExtractedArchitecture({ discovery, readFile: path => readFileSync(join(dir, path), "utf8") }).extraction;
    const share = extraction.entities.filter(entity => entity.kind === "component" && entity.sourceRefs.some(ref => ref.path === "apps/web/api/share.ts"));
    assert.equal(share.length, 1);
    assert.equal(share[0]!.parentId, "container:apps-web-api");
    assert.deepEqual(membershipDiagnostics(extraction, path => readFileSync(join(dir, path), "utf8"), new Set()), []);
  });
});

test("nested fixture member: its files are skipped with the member instead of leaking into the parent package (behaviour change)", () => {
  withCommittedRepo({
    ...WORKSPACE_BASE,
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n  - packages/*/examples/*\n",
    "packages/core/examples/demo/package.json": JSON.stringify({ name: "demo" }),
    "packages/core/examples/demo/src/d.ts": "export const d = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.deepEqual(discovery.summary.skippedMembers, ["packages/core/examples/demo"]);
    assert.equal(discovery.unitByFile.get("packages/core/examples/demo/src/d.ts"), undefined);
    assert.equal(discoverRepository(dir, { includeAllMembers: true }).unitByFile.get("packages/core/examples/demo/src/d.ts"), "packages/core/examples/demo");
  });
});

test("CLA-263 regression: root re-export shims fold into the app-level api/ container without becoming evidence", () => {
  withCommittedRepo(VERCEL_SHIM_REPO, dir => {
    const discovery = discoverRepository(dir);
    const expectedAliases = [
      { path: "api/og.ts", target: "apps/web/api/og.ts", unit: "apps/web" },
      { path: "api/share.ts", target: "apps/web/api/share.ts", unit: "apps/web" },
    ];
    assert.deepEqual(discovery.summary.reexportAliases, expectedAliases);
    assert.ok(!discovery.sourceFiles.includes("api/share.ts"));
    assert.equal(discovery.unitByFile.get("scripts/build.mjs"), TOOLING_UNIT_KEY);

    const artifacts = scanRepository(dir, { analysisMode: "quick", includeSource: true });
    const entities = artifacts.snapshot.entities;
    const containerName = new Map(entities.filter(entity => entity.kind === "container").map(entity => [entity.id, entity.name]));
    const components = entities.filter(entity => entity.kind === "component");

    const shareComponents = components.filter(entity => entity.sourceRefs.some(ref => ref.path.endsWith("api/share.ts")));
    assert.equal(shareComponents.length, 1, "exactly one component for share");
    const share = shareComponents[0]!;
    assert.equal(containerName.get(share.parentId!), "@acme/web");
    assert.deepEqual(share.sourceRefs.map(ref => ref.path), ["apps/web/api/share.ts"], "the shim is not a sourceRef of the target");
    assert.deepEqual(share.owners, ["@web"], "CODEOWNERS for the shim's /api/ does not leak onto the target");

    const namesByContainer = new Map<string, Set<string>>();
    for (const component of components) {
      const containers = namesByContainer.get(component.name) ?? new Set<string>();
      containers.add(component.parentId!);
      namesByContainer.set(component.name, containers);
    }
    assert.deepEqual([...namesByContainer].filter(([, containers]) => containers.size > 1), [], "no component name duplicated across containers");

    const tooling = components.filter(entity => entity.parentId === "container:tooling").map(entity => entity.sourceRefs[0]!.path);
    assert.deepEqual(tooling, ["scripts/build.mjs"], "tooling holds scripts only");
    assert.ok(!artifacts.snapshot.relations.some(relation => relation.from === "container:tooling" && relation.to === "container:apps-web"), "no shim-made tooling->web relation");

    // Persisted, not just printed: the scan artifacts and the portable bundle carry the fold.
    assert.deepEqual(artifacts.membership, { reexportAliases: expectedAliases, diagnostics: [] });
    const bundle = parsePortableAtlas(serializePortableAtlas(portableAtlasFromScan(artifacts)));
    assert.deepEqual(bundle.analysis.membership, { reexportAliases: expectedAliases, diagnostics: [] });
    // portableSourcePaths: bundled sources are the cited files — the target, never the uncited shim.
    const sourcePaths = (artifacts.sources ?? []).map(source => source.path);
    assert.ok(sourcePaths.includes("apps/web/api/share.ts"));
    assert.ok(!sourcePaths.includes("api/share.ts"));
  });
});

test("membership diagnostic fires end-to-end on the pre-fix shape (folding disabled) and is silent with folding", () => {
  withCommittedRepo(VERCEL_SHIM_REPO, dir => {
    const unfolded = artifactsFor(dir, { foldReexportShims: false });
    const dupes = unfolded.extraction.entities.filter(entity => entity.kind === "component" && entity.name === "api/share.ts");
    assert.equal(dupes.length, 2, "pre-fix shape: the same display name in two containers");
    const reexports = unfolded.membership.diagnostics.filter(diagnostic => diagnostic.code === "reexport-across-containers");
    assert.deepEqual(reexports.map(diagnostic => [diagnostic.path, diagnostic.target, diagnostic.containerIds, diagnostic.entityIds]), [
      ["api/og.ts", "apps/web/api/og.ts", ["container:apps-web", "container:tooling"], ["component:api-og-ts", "component:apps-web-api-og-ts"]],
      ["api/share.ts", "apps/web/api/share.ts", ["container:apps-web", "container:tooling"], ["component:api-share-ts", "component:apps-web-api-share-ts"]],
    ]);
    assert.match(reexports[1]!.message, /same name "api\/share\.ts"/);
    assert.equal(unfolded.membership.reexportAliases.length, 0);
    assert.ok(unfolded.analysis.membership, "warnings reach the portable analysis block");
    assert.ok(unfolded.snapshot.entities.length > 0, "non-fatal: the scan still completes");

    const folded = artifactsFor(dir);
    assert.deepEqual(folded.membership.diagnostics, []);
  });
});

test("folding keeps dependency facts: importers of a folded barrel resolve to its target", () => {
  const files = {
    ...WORKSPACE_BASE,
    "scripts/lib/index.ts": "export * from '../../packages/core/src/util';\n",
    "scripts/build.ts": "import { util } from './lib';\nexport const b = util;\n",
  };
  withCommittedRepo(files, dir => {
    const discovery = discoverRepository(dir);
    assert.deepEqual(discovery.summary.reexportAliases, [{ path: "scripts/lib/index.ts", target: "packages/core/src/util.ts", unit: "packages/core" }]);
    const { extraction } = artifactsFor(dir);
    const relations = extraction.relations.map(relation => `${relation.from}->${relation.to}`).sort();
    assert.ok(relations.includes("component:scripts-build-ts->component:packages-core-src-util-ts"), relations.join("\n"));
    assert.ok(relations.includes("code:scripts-build-ts:b->code:packages-core-src-util-ts:util"), relations.join("\n"));
    const unfolded = artifactsFor(dir, { foldReexportShims: false }).extraction.relations.map(relation => `${relation.from}->${relation.to}`);
    assert.ok(unfolded.includes("component:scripts-build-ts->component:scripts-lib-index-ts"), "pre-fix: the edge went to the shim");
    assert.ok(!relations.some(relation => relation.includes("scripts-lib-index-ts")), "no edge to the folded shim");
  });
});

const TOOLING_MEMBER_REPO: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme" }),
  "tsconfig.json": "{}",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - tooling\n",
  "apps/web/package.json": JSON.stringify({ name: "@acme/web" }),
  "apps/web/src/main.ts": "export const main = 1;\n",
  "tooling/package.json": JSON.stringify({ name: "@acme/tooling" }),
  "tooling/src/x.ts": "export const x = 1;\n",
  "tooling/src/re.ts": "export * from '../../apps/web/src/main';\n",
};

test("a member literally named `tooling` is never folded and never spawns a phantom tooling container", () => {
  withCommittedRepo(TOOLING_MEMBER_REPO, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.reexportAliases, undefined, "member files are never folded");
    assert.equal(discovery.unitByFile.get("tooling/src/re.ts"), "tooling");
    assert.deepEqual(discovery.units.map(unit => [unit.kind, unit.dir]), [["member", "apps/web"], ["member", "tooling"]]);
    const artifacts = artifactsFor(dir);
    assert.deepEqual(artifacts.extraction.entities.filter(entity => entity.kind === "container").map(entity => entity.id).sort(), ["container:apps-web", "container:tooling"]);
    assert.equal(artifacts.analysis.membership, undefined, "a member's own barrel is not a membership warning");
  });
});

test("a member named `tooling` plus stray non-member files: two distinct containers, each keeping its own files", () => {
  withCommittedRepo({ ...TOOLING_MEMBER_REPO, "scripts/build.ts": "export const build = 1;\n" }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.unitByFile.get("tooling/src/x.ts"), "tooling");
    assert.equal(discovery.unitByFile.get("scripts/build.ts"), TOOLING_UNIT_KEY);
    assert.deepEqual(discovery.units.map(unit => [unit.kind, unit.dir]), [["member", "apps/web"], ["member", "tooling"], ["tooling", TOOLING_UNIT_KEY]]);
    const { extraction } = artifactsFor(dir);
    const containers = extraction.entities.filter(entity => entity.kind === "container");
    const containerOf = (path: string) => containers.find(container => container.id === extraction.entities.find(entity => entity.kind === "component" && entity.sourceRefs[0]?.path === path)?.parentId);
    assert.equal(containerOf("tooling/src/x.ts")?.name, "@acme/tooling", "the member keeps its files");
    assert.equal(containerOf("tooling/src/re.ts")?.name, "@acme/tooling");
    assert.equal(containerOf("scripts/build.ts")?.name, "Build & fixture tooling");
    assert.equal(containerOf("tooling/src/x.ts")?.id, "container:tooling", "the member keeps the bare id");
    assert.equal(containerOf("scripts/build.ts")?.id, "container:tooling-2", "the bucket takes the collision suffix");
    for (const container of containers.filter(container => container.id !== "system:acme")) {
      assert.ok(extraction.entities.some(entity => entity.kind === "component" && entity.parentId === container.id), `${container.id} is not empty`);
    }
    assert.ok(!JSON.stringify(extraction).includes("\\u0000"), "the bucket key never leaks into output");
  });
});

test("an ordinary member barrel re-exporting another package emits no membership warning", () => {
  withCommittedRepo({
    ...WORKSPACE_BASE,
    "apps/web/src/core.ts": "export * from '../../../packages/core/src/util';\n",
  }, dir => {
    const artifacts = artifactsFor(dir);
    assert.deepEqual(artifacts.membership, { reexportAliases: [], diagnostics: [] });
    assert.ok(!("membership" in artifacts.analysis), "no-shim repo: analysis has no membership key (atlas bytes unchanged)");
    assert.equal(discoverRepository(dir).summary.reexportAliases, undefined);
  });
});

test("tooling container is pruned when every non-member file was a folded shim", () => {
  const { "scripts/build.mjs": _dropped, ...files } = VERCEL_SHIM_REPO;
  withCommittedRepo(files, dir => {
    const discovery = discoverRepository(dir);
    assert.ok(!discovery.units.some(unit => unit.kind === "tooling"));
    assert.ok(![...discovery.unitByFile.values()].includes(TOOLING_UNIT_KEY));
    assert.equal(discovery.summary.reexportAliases?.length, 2);
  });
});

test("a shim re-exporting another tooling file (or nothing discovered) is kept as its own component", () => {
  withCommittedRepo({
    ...WORKSPACE_BASE,
    "scripts/lib.ts": "export const lib = 1;\n",
    "scripts/index.ts": "export * from './lib';\n",
    "api/missing.ts": "export { default } from '../apps/web/api/gone.ts';\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.reexportAliases, undefined);
    assert.equal(discovery.unitByFile.get("scripts/index.ts"), TOOLING_UNIT_KEY);
    assert.equal(discovery.unitByFile.get("api/missing.ts"), TOOLING_UNIT_KEY);
  });
});

test("membership diagnostic fires on a synthetic overlap", () => {
  const extraction: Pick<ArchitectureExtraction, "entities"> = {
    entities: [
      { id: "system:acme", kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      { id: "container:apps-web", kind: "container", parentId: "system:acme", name: "@acme/web", sourceRefs: [{ path: "apps/web" }] },
      { id: "container:tooling", kind: "container", parentId: "system:acme", name: "Build & fixture tooling", sourceRefs: [{ path: "scripts" }] },
      { id: "component:apps-web-api-share-ts", kind: "component", parentId: "container:apps-web", name: "api/share.ts", sourceRefs: [{ path: "apps/web/api/share.ts" }] },
      { id: "component:tooling-share", kind: "component", parentId: "container:tooling", name: "api/share.ts", sourceRefs: [{ path: "apps/web/api/share.ts" }] },
      { id: "code:tooling-share-x", kind: "code", parentId: "component:tooling-share", name: "x", sourceRefs: [{ path: "scripts/ok.ts", startLine: 1 }] },
      { id: "code:web-x", kind: "code", parentId: "component:apps-web-api-share-ts", name: "x", sourceRefs: [{ path: "scripts/ok.ts", startLine: 1 }] },
    ],
  };
  const expected = [
    { path: "apps/web/api/share.ts", containerIds: ["container:apps-web", "container:tooling"], entityIds: ["component:apps-web-api-share-ts", "component:tooling-share"] },
    { path: "scripts/ok.ts", containerIds: ["container:apps-web", "container:tooling"], entityIds: ["code:tooling-share-x", "code:web-x"] },
  ];
  const diagnostics = membershipDiagnostics(extraction, () => { throw new Error("unreadable"); }, new Set(["apps/web/api/share.ts", "scripts/ok.ts"]));
  assert.deepEqual(diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity, diagnostic.path, diagnostic.containerIds, diagnostic.entityIds]),
    expected.map(overlap => ["file-in-multiple-containers", "warning", overlap.path, overlap.containerIds, overlap.entityIds]));
  const exclusive = { entities: extraction.entities.filter(entity => entity.id !== "component:tooling-share" && entity.id !== "code:tooling-share-x") };
  assert.deepEqual(membershipDiagnostics(exclusive, () => "", new Set(["apps/web/api/share.ts", "scripts/ok.ts"])), []);
});
