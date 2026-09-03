import assert from "node:assert/strict";
import test from "node:test";
import {
  type ArchitectureSnapshot,
  type ArchitectureView,
  type EntityKind,
  type StoryDetail,
} from "./model.js";
import {
  C4_DIAGRAM_TYPE_LABELS,
  C4_ELEMENT_TYPE_LABELS,
  C4_RELATION_KIND_LABELS,
  validateC4NotationCompleteness,
} from "./c4-completeness.js";
import { validateSnapshot, validateView } from "./validation.js";

const completeSnapshot: ArchitectureSnapshot = {
  schemaVersion: 1,
  id: "snapshot:c4-completeness",
  repositoryId: "repo:c4-completeness",
  commitSha: "abc123",
  generatedAt: "2026-07-16T00:00:00.000Z",
  entities: [
    {
      id: "system:payments",
      kind: "softwareSystem",
      name: "Payments",
      responsibility: "Processes merchant payments.",
      sourceRefs: [],
    },
    {
      id: "container:api",
      kind: "container",
      parentId: "system:payments",
      name: "Payments API",
      responsibility: "Accepts and validates payment requests.",
      technology: ["Node.js"],
      sourceRefs: [],
    },
    {
      id: "external:bank",
      kind: "externalSystem",
      name: "Bank",
      responsibility: "Authorises card payments.",
      sourceRefs: [],
    },
  ],
  relations: [{
    id: "relation:api-bank",
    from: "container:api",
    to: "external:bank",
    kind: "calls",
    label: "requests payment authorisation",
    technology: "HTTPS/JSON",
    evidence: [],
  }],
};

const completeView: ArchitectureView = {
  schemaVersion: 1,
  id: "view:payments-containers",
  snapshotId: completeSnapshot.id,
  name: "Payments container diagram",
  rootEntityId: "system:payments",
  entityIds: completeSnapshot.entities.map(entity => entity.id),
  relationIds: completeSnapshot.relations.map(relation => relation.id),
  layout: {
    nodes: Object.fromEntries(completeSnapshot.entities.map((entity, index) => [
      entity.id,
      { x: index * 200, y: 0, width: 160, height: 100 },
    ])),
  },
};

test("accepts a complete L2 diagram using the view title and root scope", () => {
  assert.deepEqual(validateC4NotationCompleteness({
    snapshot: completeSnapshot,
    view: completeView,
    diagramType: "container",
  }), []);
});

test("reports advisory C4 omissions deterministically without changing structural validation", () => {
  const snapshot: ArchitectureSnapshot = {
    ...completeSnapshot,
    entities: completeSnapshot.entities.map(entity => {
      if (entity.id === "system:payments") return { ...entity, responsibility: " " };
      if (entity.id !== "container:api") return entity;
      const { responsibility: _responsibility, ...withoutResponsibility } = entity;
      return { ...withoutResponsibility, technology: [" "] };
    }),
    relations: [{
      id: "relation:api-loop",
      from: "container:api",
      to: "container:api",
      kind: "calls",
      label: " ",
      technology: " ",
      evidence: [],
    }],
  };
  const view: ArchitectureView = {
    ...completeView,
    name: " ",
    relationIds: ["relation:api-loop"],
  };
  const diagnostics = validateC4NotationCompleteness({ snapshot, view, diagramType: "container" });
  const reordered = validateC4NotationCompleteness({
    snapshot: {
      ...snapshot,
      entities: [...snapshot.entities].reverse(),
      relations: [...snapshot.relations].reverse(),
    },
    view: {
      ...view,
      entityIds: [...view.entityIds].reverse(),
      relationIds: [...view.relationIds].reverse(),
    },
    diagramType: "container",
  });

  assert.deepEqual(reordered, diagnostics);
  assert.deepEqual(diagnostics.map(value => value.code), [
    "diagram.title.missing",
    "element.description.missing",
    "element.technology.missing",
    "element.description.missing",
    "relationship.direction.invalid",
    "relationship.label.missing",
    "relationship.technology.missing",
  ]);
  assert.ok(diagnostics.every(value => value.severity === "advisory"));
  assert.deepEqual(
    diagnostics.find(value => value.code === "element.technology.missing")?.glossaryTerms,
    [{ category: "element-type", key: "container", label: "Container" }],
  );
  assert.deepEqual(
    diagnostics.find(value => value.code === "relationship.technology.missing")?.glossaryTerms,
    [{ category: "relationship-kind", key: "calls", label: "Calls" }],
  );

  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(validateView(snapshot, view), []);
});

test("validates explicit diagram type, title, and scope metadata", () => {
  const missing = validateC4NotationCompleteness({
    snapshot: completeSnapshot,
    view: completeView,
    title: " ",
    scopeEntityId: " ",
  });
  assert.deepEqual(missing.map(value => value.code), [
    "diagram.scope.missing",
    "diagram.title.missing",
    "diagram.type.missing",
  ]);

  const unsupported = validateC4NotationCompleteness({
    snapshot: completeSnapshot,
    view: completeView,
    diagramType: "landscape" as unknown as StoryDetail,
  });
  assert.deepEqual(unsupported.map(value => value.code), ["diagram.type.unsupported"]);

  const unknownScope = validateC4NotationCompleteness({
    snapshot: completeSnapshot,
    view: completeView,
    diagramType: "container",
    scopeEntityId: "system:missing",
  });
  assert.deepEqual(unknownScope.map(value => value.code), ["diagram.scope.unknown"]);

  const incompatibleScope = validateC4NotationCompleteness({
    snapshot: completeSnapshot,
    view: completeView,
    diagramType: "component",
    scopeEntityId: "system:payments",
  });
  assert.deepEqual(incompatibleScope.map(value => value.code), ["diagram.scope.incompatible"]);
  assert.deepEqual(incompatibleScope[0]?.glossaryTerms, [
    { category: "diagram-type", key: "component", label: "Component diagram" },
    { category: "element-type", key: "container", label: "Container" },
  ]);

  const outsideSnapshot: ArchitectureSnapshot = {
    ...completeSnapshot,
    entities: [...completeSnapshot.entities, {
      id: "system:outside",
      kind: "softwareSystem",
      name: "Outside",
      responsibility: "Not part of this view.",
      sourceRefs: [],
    }],
  };
  const outsideView = validateC4NotationCompleteness({
    snapshot: outsideSnapshot,
    view: completeView,
    diagramType: "container",
    scopeEntityId: "system:outside",
  });
  assert.deepEqual(outsideView.map(value => value.code), ["diagram.scope.outside-view"]);
});

test("requires technology on L3 components but reserves relationship protocol advice for L2", () => {
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:components",
    repositoryId: "repo:components",
    commitSha: "abc123",
    generatedAt: "2026-07-16T00:00:00.000Z",
    entities: [
      {
        id: "container:service",
        kind: "container",
        name: "Service",
        responsibility: "Hosts the business components.",
        sourceRefs: [],
      },
      {
        id: "component:handler",
        kind: "component",
        parentId: "container:service",
        name: "Handler",
        responsibility: "Handles requests.",
        sourceRefs: [],
      },
      {
        id: "component:store",
        kind: "component",
        parentId: "container:service",
        name: "Store",
        responsibility: "Stores request state.",
        technology: ["TypeScript"],
        sourceRefs: [],
      },
    ],
    relations: [{
      id: "relation:handler-store",
      from: "component:handler",
      to: "component:store",
      kind: "calls",
      label: "stores request state",
      evidence: [],
    }],
  };
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:components",
    snapshotId: snapshot.id,
    name: "Service components",
    rootEntityId: "container:service",
    entityIds: snapshot.entities.map(entity => entity.id),
    relationIds: snapshot.relations.map(relation => relation.id),
    layout: {
      nodes: Object.fromEntries(snapshot.entities.map((entity, index) => [
        entity.id,
        { x: index * 200, y: 0, width: 160, height: 100 },
      ])),
    },
  };

  const diagnostics = validateC4NotationCompleteness({ snapshot, view, diagramType: "component" });
  assert.deepEqual(diagnostics.map(value => [value.code, value.subject.id]), [
    ["element.technology.missing", "component:handler"],
  ]);
});

test("reports an unsupported runtime element type and exports stable C4 terminology", () => {
  const snapshot: ArchitectureSnapshot = {
    ...completeSnapshot,
    entities: completeSnapshot.entities.map(entity => entity.id === "external:bank"
      ? { ...entity, kind: "service" as unknown as EntityKind }
      : entity),
  };
  const diagnostics = validateC4NotationCompleteness({ snapshot, view: completeView, diagramType: "container" });
  assert.deepEqual(diagnostics.map(value => value.code), ["element.type.unsupported"]);
  assert.equal(C4_DIAGRAM_TYPE_LABELS.container, "Container diagram");
  assert.equal(C4_ELEMENT_TYPE_LABELS.softwareSystem, "Software system");
  assert.equal(C4_RELATION_KIND_LABELS.dependsOn, "Depends on");
  assert.equal(C4_RELATION_KIND_LABELS.duplicates, "Duplicates");
});
