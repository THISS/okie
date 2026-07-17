import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  adaptArchitectureExtraction,
  validateArchitectureExtraction,
  validateSnapshot,
  type ArchitectureExtraction,
  type ArchitectureExtractionEntity,
  type ArchitectureExtractionSnapshotMetadata,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import { scanRepository } from "./scan.js";

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
  "pkg/c/src/config.ts": "export default 1;\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};
function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", "pkg/c/src/config.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b" },
      { kind: "member", dir: "pkg/c", name: "@acme/c", packageName: "@acme/c", evidencePath: "pkg/c" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"], ["pkg/c/src/config.ts", "pkg/c"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]]),
  };
}
function base(): ArchitectureExtraction {
  return extractArchitecture({ discovery: discovery(), readFile: read, systemName: "Acme", systemSlug: "acme" });
}
const metadata: ArchitectureExtractionSnapshotMetadata = {
  snapshotId: "snapshot:acme:abc123def456",
  repositoryId: "repo:acme",
  commitSha: "abc123def456",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function containerCode(extraction: ArchitectureExtraction, containerId: string): ArchitectureExtractionEntity[] {
  const byId = new Map(extraction.entities.map(entity => [entity.id, entity]));
  return extraction.entities.filter(entity => {
    if (entity.kind !== "code" || entity.parentId === undefined) return false;
    return byId.get(entity.parentId)?.parentId === containerId;
  });
}

type Doc = Record<string, unknown>;

/** A compliant single-logical-component proposal for a container. */
function validDoc(extraction: ArchitectureExtraction, containerId: string): Doc {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const local = containerId.slice("container:".length);
  const logicalId = `component:${local}-core`;
  const code = containerCode(extraction, containerId);
  return {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: container.id, kind: "container", parentId: system.id, name: container.name, sourceRefs: [] },
      { id: logicalId, kind: "component", parentId: containerId, name: "Core", responsibility: "Groups the module.", sourceRefs: [] },
      ...code.map(entity => ({ id: entity.id, kind: "code", parentId: logicalId, name: entity.name, sourceRefs: entity.sourceRefs.map(ref => ({ ...ref })) })),
    ],
    relations: [],
  };
}

/** A compliant proposal that puts each file in its own component (whole-file cohesion). */
function validDocPerFile(extraction: ArchitectureExtraction, containerId: string): Doc {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const local = containerId.slice("container:".length);
  const code = containerCode(extraction, containerId);
  const paths = [...new Set(code.map(entity => entity.sourceRefs[0]!.path))].sort();
  const componentByPath = new Map(paths.map((path, index) => [path, `component:${local}-group${index}`]));
  const components = paths.map(path => ({
    id: componentByPath.get(path)!, kind: "component", parentId: containerId,
    name: `Group ${path}`, responsibility: "One file.", sourceRefs: [],
  }));
  return {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: container.id, kind: "container", parentId: system.id, name: container.name, sourceRefs: [] },
      ...components,
      ...code.map(entity => ({
        id: entity.id, kind: "code", parentId: componentByPath.get(entity.sourceRefs[0]!.path)!,
        name: entity.name, sourceRefs: entity.sourceRefs.map(ref => ({ ...ref })),
      })),
    ],
    relations: [],
  };
}

test("accepts a valid proposal: re-parents code, validates, keeps observed facts byte-identical", () => {
  const extraction = base();
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([["container:pkg-a", validDoc(extraction, "container:pkg-a")]]));

  assert.equal(report.results.find(result => result.containerId === "container:pkg-a")?.accepted, true);
  assert.deepEqual(validateArchitectureExtraction(merged), []);
  assert.deepEqual(validateSnapshot(adaptArchitectureExtraction(merged, metadata)), []);

  assert.ok(merged.entities.some(entity => entity.id === "component:pkg-a-core"));
  assert.ok(!merged.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"), "file-component replaced");

  const alpha = merged.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  const baseAlpha = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  assert.equal(alpha.parentId, "component:pkg-a-core", "re-parented");
  assert.deepEqual(alpha.sourceRefs, baseAlpha.sourceRefs, "observed refs unchanged");
  assert.equal(alpha.name, baseAlpha.name, "observed name unchanged");

  // index.ts -> util.ts (both grouped into core) collapses to a self-loop and is dropped.
  assert.ok(!merged.relations.some(relation => relation.from === relation.to));
  // container->container survives untouched.
  assert.ok(merged.relations.some(relation => relation.from === "container:pkg-b" && relation.to === "container:pkg-a"));
});

test("remaps intra-container file->file edges to logical->logical", () => {
  const extraction = base();
  const { extraction: merged } = mergeEnrichment(extraction, new Map([["container:pkg-a", validDocPerFile(extraction, "container:pkg-a")]]));
  // index.ts=group0, util.ts=group1; the index->util import becomes group0->group1.
  assert.ok(
    merged.relations.some(relation => relation.from === "component:pkg-a-group0" && relation.to === "component:pkg-a-group1"),
    `expected remapped logical edge, got ${JSON.stringify(merged.relations.map(r => [r.from, r.to]))}`,
  );
  assert.deepEqual(validateSnapshot(adaptArchitectureExtraction(merged, metadata)), []);
});

function expectReject(mutate: (doc: Doc, extraction: ArchitectureExtraction) => void, containerId = "container:pkg-a"): string[] {
  const extraction = base();
  const doc = validDoc(extraction, containerId);
  mutate(doc, extraction);
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([[containerId, doc]]));
  const result = report.results.find(entry => entry.containerId === containerId)!;
  assert.equal(result.accepted, false, `expected rejection; reasons=${result.reasons.join("; ")}`);
  assert.ok(result.reasons.length > 0);
  // atomic: the scope falls back to its deterministic file-component base, still valid.
  assert.ok(merged.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"), "scope kept file-components");
  assert.ok(!merged.entities.some(entity => entity.id === "component:pkg-a-core"), "no partial merge");
  assert.deepEqual(validateArchitectureExtraction(merged), [], "deterministic base still publishes");
  return result.reasons;
}

test("rejects (atomic, scope stays on base): out-of-scope, mutated ref, coverage, cohesion, relations, malformed", () => {
  expectReject(doc => { (doc.entities as ArchitectureExtractionEntity[])[2]!.sourceRefs = [{ path: "pkg/b/src/main.ts" }]; }); // component cites out-of-scope
  expectReject(doc => {
    const code = (doc.entities as ArchitectureExtractionEntity[]).find(e => e.kind === "code")!;
    const start = (code.sourceRefs[0]!.startLine ?? 1) + 100;
    code.sourceRefs = [{ ...code.sourceRefs[0]!, startLine: start, endLine: start }]; // gate-valid but mutates the observed range
  });
  expectReject(doc => { (doc.entities as ArchitectureExtractionEntity[]).splice(3, 1); }); // drop a code entity -> incomplete coverage
  expectReject(doc => {
    // gate-valid relation (endpoints/evidence in-doc + in-scope) so the "no relations" rule is what fires
    doc.relations = [{ id: "relation:pkg-a-dep", from: "container:pkg-a", to: "component:pkg-a-core", kind: "dependsOn", evidence: [{ source: { path: "pkg/a/src/index.ts" } }] }];
  });
  // file-cohesion: split index.ts's two symbols across two components.
  expectReject((doc, extraction) => {
    const local = "pkg-a";
    const second = { id: `component:${local}-split`, kind: "component", parentId: "container:pkg-a", name: "Split", sourceRefs: [] };
    (doc.entities as ArchitectureExtractionEntity[]).splice(3, 0, second as ArchitectureExtractionEntity);
    const a = (doc.entities as ArchitectureExtractionEntity[]).find(e => e.id === "code:pkg-a-src-index-ts:a");
    if (a) a.parentId = `component:${local}-split`;
    void extraction;
  });
  // malformed JSON handled at the map layer (a non-object doc).
  const extraction = base();
  const { report } = mergeEnrichment(extraction, new Map([["container:pkg-a", "not-an-object"]]));
  assert.equal(report.results[0]!.accepted, false);
});

test("merge is independent of document order", () => {
  const extraction = base();
  const docA = validDoc(extraction, "container:pkg-a");
  const docB = validDoc(extraction, "container:pkg-b");
  const forward = mergeEnrichment(extraction, new Map([["container:pkg-a", docA], ["container:pkg-b", docB]])).extraction;
  const reverse = mergeEnrichment(extraction, new Map([["container:pkg-b", docB], ["container:pkg-a", docA]])).extraction;
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
});

test("replay is byte-identical for the same base + docs", () => {
  const first = mergeEnrichment(base(), new Map([["container:pkg-a", validDoc(base(), "container:pkg-a")]])).extraction;
  const second = mergeEnrichment(base(), new Map([["container:pkg-a", validDoc(base(), "container:pkg-a")]])).extraction;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("end-to-end: enriching a real Okie container yields a valid, compiling snapshot", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const baseArtifacts = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });
  const containerId = "container:tooling";
  const doc = validDoc(baseArtifacts.baseExtraction, containerId);

  const enriched = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie", enrichmentDocs: new Map([[containerId, doc]]) });
  assert.equal(enriched.enrichmentReport?.enrichedContainers.includes(containerId), true);
  assert.deepEqual(validateSnapshot(enriched.snapshot), []);
  assert.ok(enriched.snapshot.entities.some(entity => entity.id === "component:tooling-core"));
  assert.ok(enriched.scene.objects.length > 0, "scene compiled");
});
