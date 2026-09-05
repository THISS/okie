import assert from "node:assert/strict";
import test from "node:test";
import {
  ASPECT_PRESET_TARGET,
  C4_BAND_FOCUS_ZOOM,
  buildC4ProjectionBundle,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type EntityKind,
} from "@okie/architecture";
import { C4_ZOOM_BANDS, NO_SUMMARY_SUPPLIED, compileC4Scene } from "./compile-c4.js";
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
  assert.equal(compiled.scene.objects.some(object => omitted.includes(object.id)), false);
  const reserved = compiled.projections.bandLayoutById[
    compiled.projections.projectionById[compiled.projections.family.projectionIds.code]!.layoutId
  ]?.reservedShells ?? {};
  assert.ok(omitted.some(id => reserved[id]), "omitted cards keep reserved shells on the owner");
  const owner = compiled.scene.objects.find(object => object.id === "visual-node:component:file");
  assert.ok(owner, "resident owner stays a protocol object");
  const reservedRects = owner.representations.flatMap(representation =>
    representation.primitives.filter(primitive => primitive.kind === "roundedRect"),
  );
  assert.ok(reservedRects.length > omitted.length, "owner paints blank reserved child shells");
  for (const object of compiled.scene.objects) {
    const texts = object.representations.flatMap(representation =>
      representation.primitives.flatMap(primitive => primitive.kind === "text" ? [primitive.content] : []),
    );
    assert.equal(texts.includes(NO_SUMMARY_SUPPLIED) && omitted.includes(object.id), false);
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

test("CLA-81: hang-guard stays 2000 and focus zooms stay locked to the compiler", () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
  for (const band of C4_ZOOM_BANDS) {
    assert.equal(C4_BAND_FOCUS_ZOOM[band.detail], band.focusZoom);
  }
});
