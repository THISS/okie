import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptArchitectureExtraction,
  ArchitectureExtractionError,
  type ArchitectureExtraction,
  type ArchitectureExtractionSnapshotMetadata,
  validateArchitectureExtraction,
} from "./extraction.js";

const metadata: ArchitectureExtractionSnapshotMetadata = {
  snapshotId: "snapshot:extraction-test",
  repositoryId: "repo:extraction-test",
  commitSha: "0123456789abcdef",
  generatedAt: "2026-07-15T00:00:00.000Z",
};

const extraction: ArchitectureExtraction = {
  schemaVersion: 1,
  entities: [
    {
      id: "system:atlas",
      kind: "softwareSystem",
      name: "Atlas",
      responsibility: "Presents repository architecture.",
      technology: ["TypeScript", "Rust"],
      tags: ["architecture", "local"],
      sourceRefs: [{ path: "README.md", symbol: "Atlas" }],
      confidence: 0.99,
    },
    {
      id: "container:model",
      kind: "container",
      parentId: "system:atlas",
      name: "Architecture model",
      sourceRefs: [{ path: "packages/architecture/src/model.ts" }],
    },
    {
      id: "component:selectors",
      kind: "component",
      parentId: "container:model",
      name: "Selectors",
      sourceRefs: [
        { path: "packages/architecture/src/normalized.ts", symbol: "selectScopedView", startLine: 10, endLine: 12 },
        { path: "packages/architecture/src/model.ts", symbol: "ArchitectureView" },
      ],
    },
    {
      id: "component:schema",
      kind: "component",
      parentId: "container:model",
      name: "Schema",
      sourceRefs: [{ path: "packages/architecture/src/model.ts", symbol: "ArchitectureEntity" }],
    },
    {
      id: "code:selectors:select-scoped-view",
      kind: "code",
      parentId: "component:selectors",
      name: "selectScopedView()",
      sourceRefs: [{ path: "packages/architecture/src/normalized.ts", symbol: "selectScopedView", startLine: 10, endLine: 12 }],
    },
  ],
  relations: [{
    id: "relation:selectors-schema:reads",
    from: "component:selectors",
    to: "component:schema",
    kind: "reads",
    label: "reads semantic records",
    technology: "TypeScript",
    evidence: [
      {
        source: { path: "packages/architecture/src/normalized.ts", symbol: "selectScopedView", startLine: 10, endLine: 12 },
        reason: "The selector reads the semantic view.",
      },
      {
        source: { path: "packages/architecture/src/model.ts", symbol: "ArchitectureView" },
        reason: "The selected record is declared here.",
      },
    ],
    confidence: 0.98,
  }],
};

function reverseExtraction(value: ArchitectureExtraction): ArchitectureExtraction {
  return {
    ...value,
    entities: [...value.entities].reverse().map(entity => ({
      ...entity,
      ...(entity.technology ? { technology: [...entity.technology].reverse() } : {}),
      ...(entity.tags ? { tags: [...entity.tags].reverse() } : {}),
      sourceRefs: [...entity.sourceRefs].reverse(),
    })),
    relations: [...value.relations].reverse().map(relation => ({
      ...relation,
      evidence: [...relation.evidence].reverse(),
    })),
  };
}

test("semantic extraction deterministically pins source anchors into an existing snapshot", () => {
  const original = structuredClone(extraction);
  const first = adaptArchitectureExtraction(extraction, metadata);
  const reordered = adaptArchitectureExtraction(reverseExtraction(extraction), metadata);

  assert.deepEqual(reordered, first);
  assert.deepEqual(extraction, original, "adaptation must not mutate LLM facts");
  assert.deepEqual(first.entities.map(entity => entity.id), [...first.entities.map(entity => entity.id)].sort());
  assert.deepEqual(first.relations.map(relation => relation.id), [...first.relations.map(relation => relation.id)].sort());
  assert.equal(first.id, metadata.snapshotId);
  assert.equal(first.repositoryId, metadata.repositoryId);
  assert.equal(first.commitSha, metadata.commitSha);
  assert.equal(first.generatedAt, metadata.generatedAt);
  assert.ok(first.entities.every(entity => entity.lineageId === entity.id));
  assert.ok(first.relations.every(relation => relation.lineageId === relation.id));
  assert.ok(first.entities.every(entity => entity.fingerprint?.startsWith("extraction:v1:entity:")));
  assert.ok(first.relations.every(relation => relation.fingerprint?.startsWith("extraction:v1:relation:")));
  assert.ok(first.entities.flatMap(entity => entity.sourceRefs).every(source => source.commitSha === metadata.commitSha));
  assert.ok(first.relations.flatMap(relation => relation.evidence).every(value => value.source.commitSha === metadata.commitSha));
  assert.ok(first.entities.every(entity => entity.sourceExcerpts === undefined));
  assert.equal("layout" in first, false);
});

test("semantic fingerprints exclude volatile snapshot metadata and change with affected facts", () => {
  const first = adaptArchitectureExtraction(extraction, metadata);
  const nextRevision = adaptArchitectureExtraction(extraction, {
    ...metadata,
    snapshotId: "snapshot:extraction-test-next",
    commitSha: "fedcba9876543210",
    generatedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.deepEqual(
    nextRevision.entities.map(entity => [entity.id, entity.fingerprint]),
    first.entities.map(entity => [entity.id, entity.fingerprint]),
  );
  assert.deepEqual(
    nextRevision.relations.map(relation => [relation.id, relation.fingerprint]),
    first.relations.map(relation => [relation.id, relation.fingerprint]),
  );

  const changed: ArchitectureExtraction = {
    ...extraction,
    entities: extraction.entities.map(entity => entity.id === "component:selectors"
      ? { ...entity, responsibility: "Selects a root-scoped semantic view." }
      : entity),
  };
  const adapted = adaptArchitectureExtraction(changed, metadata);
  const beforeById = new Map(first.entities.map(entity => [entity.id, entity.fingerprint]));
  const afterById = new Map(adapted.entities.map(entity => [entity.id, entity.fingerprint]));
  assert.notEqual(afterById.get("component:selectors"), beforeById.get("component:selectors"));
  for (const id of beforeById.keys()) {
    if (id !== "component:selectors") assert.equal(afterById.get(id), beforeById.get(id));
  }
});

test("explicit host reconciliation overrides derived identity without entering extraction JSON", () => {
  const snapshot = adaptArchitectureExtraction(extraction, {
    ...metadata,
    reconciliation: {
      entities: {
        "component:selectors": {
          lineageId: "lineage:component:selectors-established",
          fingerprint: "reconciled:selectors:v7",
        },
      },
      relations: {
        "relation:selectors-schema:reads": {
          lineageId: "lineage:relation:selectors-schema-reads",
        },
      },
    },
  });
  const selectors = snapshot.entities.find(entity => entity.id === "component:selectors")!;
  const relation = snapshot.relations[0]!;
  assert.equal(selectors.lineageId, "lineage:component:selectors-established");
  assert.equal(selectors.fingerprint, "reconciled:selectors:v7");
  assert.equal(relation.lineageId, "lineage:relation:selectors-schema-reads");
  assert.ok(relation.fingerprint?.startsWith("extraction:v1:relation:"));
});

test("strict extraction validation rejects pipeline-owned and geometric fields", () => {
  const value = structuredClone(extraction) as unknown as Record<string, unknown>;
  value.commitSha = "LLM-must-not-pin-this";
  const entities = value.entities as Array<Record<string, unknown>>;
  entities[0]!.lineageId = "lineage:system:atlas";
  entities[0]!.fingerprint = "LLM-must-not-author-this";
  entities[0]!.sourceExcerpts = [];
  entities[0]!.owners = ["@llm-must-not-author-this"];
  entities[0]!.cyclomaticComplexity = 9;
  const refs = entities[0]!.sourceRefs as Array<Record<string, unknown>>;
  refs[0]!.commitSha = "LLM-must-not-pin-this";
  const relations = value.relations as Array<Record<string, unknown>>;
  relations[0]!.route = { points: [{ x: 0, y: 0 }] };

  const paths = validateArchitectureExtraction(value).map(issue => issue.path);
  assert.ok(paths.includes("commitSha"));
  assert.ok(paths.includes("entities[0].lineageId"));
  assert.ok(paths.includes("entities[0].fingerprint"));
  assert.ok(paths.includes("entities[0].sourceExcerpts"));
  assert.ok(paths.includes("entities[0].owners"));
  assert.ok(paths.includes("entities[0].cyclomaticComplexity"));
  assert.ok(paths.includes("entities[0].sourceRefs[0].commitSha"));
  assert.ok(paths.includes("relations[0].route"));
});

test("validation enforces typed IDs, C4 hierarchy, paths, endpoints, evidence, and confidence", () => {
  const invalid = structuredClone(extraction) as unknown as ArchitectureExtraction;
  invalid.entities = [
    {
      id: "component:top-level",
      kind: "component",
      name: "Top level component",
      sourceRefs: [{ path: "../outside.ts" }],
      confidence: 2,
    },
    {
      id: "container:wrong-kind-prefix",
      kind: "code",
      parentId: "component:top-level",
      name: "x".repeat(200),
      sourceRefs: [{ path: "https://example.test/source.ts" }],
    },
  ];
  invalid.relations = [
    {
      id: "edge:not-a-relation-id",
      from: "component:top-level",
      to: "component:top-level",
      kind: "calls",
      evidence: [],
    },
    {
      id: "relation:missing-target:reads",
      from: "component:top-level",
      to: "component:missing",
      kind: "reads",
      evidence: [{ source: { path: "C:\\outside.ts" } }],
    },
  ];

  const issues = validateArchitectureExtraction(invalid);
  const text = issues.map(issue => `${issue.path}: ${issue.message}`).join("\n");
  assert.match(text, /component requires a parent/);
  assert.match(text, /must be a typed stable ID with prefix code:/);
  assert.match(text, /safe non-empty repository-relative path/);
  assert.match(text, /finite number between 0 and 1/);
  assert.match(text, /must not exceed 160 characters/);
  assert.match(text, /relation:/);
  assert.match(text, /endpoints must be different/);
  assert.match(text, /must contain at least one evidence item/);
  assert.match(text, /unknown entity: component:missing/);
  assert.throws(() => adaptArchitectureExtraction(invalid, metadata), ArchitectureExtractionError);
});

test("validation rejects hierarchy cycles and redundant contains relations", () => {
  const value: ArchitectureExtraction = {
    schemaVersion: 1,
    entities: [
      { id: "component:a", kind: "component", parentId: "component:b", name: "A", sourceRefs: [] },
      { id: "component:b", kind: "component", parentId: "component:a", name: "B", sourceRefs: [] },
    ],
    relations: [{
      id: "relation:a-b:contains",
      from: "component:a",
      to: "component:b",
      kind: "contains",
      evidence: [{ source: { path: "src/a.ts" } }],
    }],
  };
  const messages = validateArchitectureExtraction(value).map(issue => issue.message);
  assert.ok(messages.some(message => message.includes("hierarchy contains a cycle")));
  assert.ok(messages.some(message => message.includes("must not duplicate hierarchy")));
});
