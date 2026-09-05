import assert from "node:assert/strict";
import test from "node:test";
import {
  ASPECT_PRESET_TARGET,
  buildC4ProjectionBundle,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type EntityKind,
} from "@okie/architecture";
import { NO_SUMMARY_SUPPLIED, compileC4Scene } from "./compile-c4.js";
import { BAND_COST_HANG_GUARD_ENTITIES } from "./band-cost-curve.js";

function entity(id: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return {
    id,
    name: id,
    kind,
    sourceRefs: [{ path: `${id}.ts`, commitSha: "c" }],
    ...(parentId ? { parentId } : {}),
  };
}

function fileSnapshot(codeCount: number): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity("system:d", "softwareSystem"),
    entity("container:c", "container", "system:d"),
    entity("component:file", "component", "container:c"),
  ];
  for (let index = 0; index < codeCount; index += 1) {
    entities.push(entity(`code:n${String(index).padStart(3, "0")}`, "code", "component:file"));
  }
  return {
    schemaVersion: 1,
    id: "snapshot:cla-81",
    repositoryId: "repo:cla-81",
    commitSha: "c",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations: [],
  };
}

test("CLA-81: omitted L4 cards keep reserved shells without enrichment copy", () => {
  const snapshot = fileSnapshot(40);
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: "system:d",
    focusEntityId: "component:file",
    familyId: "f",
    maxBand: "code",
    maxNodesPerBand: 12,
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const compiled = compileC4Scene(snapshot, bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
  const omitted = bundle.projectionById[bundle.family.projectionIds.code]?.omittedNodeIds ?? [];
  assert.ok(omitted.length > 0);
  const shells = compiled.scene.objects.filter(object => omitted.includes(object.id));
  assert.equal(shells.length, omitted.length);
  for (const object of shells) {
    const texts = object.representations.flatMap(representation =>
      representation.primitives.flatMap(primitive => primitive.kind === "text" ? [primitive.content] : []),
    );
    assert.equal(texts.includes(NO_SUMMARY_SUPPLIED), false, "shells must not invent summaries");
  }
});

test("CLA-81: childCounts reserve parent size so opening the band does not grow the owner", () => {
  const full = fileSnapshot(8);
  const slim: ArchitectureSnapshot = {
    ...full,
    entities: full.entities.filter(item => item.kind !== "code"),
  };
  const childCounts = { "component:file": 8, "container:c": 1, "system:d": 1 };
  const unpublished = full.entities
    .filter(item => item.kind === "code")
    .map(item => ({ id: item.id, kind: item.kind, ...(item.parentId ? { parentId: item.parentId } : {}) }));
  const slimBundle = buildC4ProjectionBundle(slim, {
    rootEntityId: "system:d",
    focusEntityId: "container:c",
    familyId: "f",
    maxBand: "component",
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const reserved = compileC4Scene(slim, slimBundle, {
    targetAspect: ASPECT_PRESET_TARGET.landscape,
    childCounts,
    unpublishedChildren: unpublished,
  });
  const openedBundle = buildC4ProjectionBundle(full, {
    rootEntityId: "system:d",
    focusEntityId: "component:file",
    familyId: "f",
    maxBand: "code",
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const opened = compileC4Scene(full, openedBundle, {
    targetAspect: ASPECT_PRESET_TARGET.landscape,
    childCounts,
  });
  const reservedFile = reserved.projections.index.boundsByEntityIdAndBand["component:file"]?.component;
  const openedFile = opened.projections.index.boundsByEntityIdAndBand["component:file"]?.code
    ?? opened.projections.index.boundsByEntityIdAndBand["component:file"]?.component;
  assert.ok(reservedFile);
  assert.ok(openedFile);
  assert.equal(Math.round(reservedFile.width * 1000), Math.round(openedFile.width * 1000));
  assert.equal(Math.round(reservedFile.height * 1000), Math.round(openedFile.height * 1000));
});

test("CLA-81: hang-guard stays 2000", () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
});
