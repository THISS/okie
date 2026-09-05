import assert from "node:assert/strict";
import test from "node:test";
import { ASPECT_PRESET_TARGET } from "./c4.js";
import { computeContainmentLayout } from "./containment-layout.js";
import { sliceArchitectureNeighborhood } from "./neighborhood.js";
import type { ArchitectureEntity, ArchitectureSnapshot, ArchitectureView, EntityKind } from "./model.js";

function entity(id: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return {
    id,
    name: id,
    kind,
    sourceRefs: [{ path: `src/${id}.ts`, commitSha: "sha" }],
    ...(parentId ? { parentId } : {}),
  };
}

function snapshot(): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity("system:root", "softwareSystem"),
    entity("container:web", "container", "system:root"),
  ];
  for (let file = 0; file < 3; file += 1) {
    const componentId = `component:f${file}`;
    entities.push(entity(componentId, "component", "container:web"));
    for (let code = 0; code < 6; code += 1) {
      entities.push(entity(`code:f${file}-n${code}`, "code", componentId));
    }
  }
  return {
    schemaVersion: 1,
    id: "snapshot:cla-81",
    repositoryId: "repo:cla-81",
    commitSha: "sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations: [],
  };
}

function viewFor(source: ArchitectureSnapshot): ArchitectureView {
  return {
    schemaVersion: 1,
    id: "view:cla-81",
    snapshotId: source.id,
    name: "cla-81",
    rootEntityId: "system:root",
    entityIds: source.entities.map(item => item.id),
    relationIds: [],
    layout: {
      nodes: Object.fromEntries(source.entities.map(item => [item.id, { x: 0, y: 0, width: 1, height: 1 }])),
    },
  };
}

test("CLA-81: L1 neighborhood replaces 1×1 placeholders with containment size hints", () => {
  const source = snapshot();
  const packet = sliceArchitectureNeighborhood(source, viewFor(source), { focusEntityId: "system:root" });
  const layout = computeContainmentLayout(
    [
      ...packet.snapshot.entities.map(item => ({
        id: item.id,
        kind: item.kind,
        ...(item.parentId ? { parentId: item.parentId } : {}),
      })),
      ...(packet.unpublishedChildren ?? []),
    ],
    { childCounts: packet.childCounts },
  );
  const container = packet.view.layout.nodes["container:web"];
  assert.ok(container);
  assert.ok(container.width > 1 && container.height > 1);
  assert.equal(container.width, layout["container:web"]?.width);
  assert.equal(container.height, layout["container:web"]?.height);
  assert.ok((packet.unpublishedChildren?.length ?? 0) >= 3);
  assert.equal(packet.childCounts["component:f0"], 6);
});

test("CLA-81: opening a neighborhood does not invent enrichment copy", () => {
  const source = snapshot();
  const packet = sliceArchitectureNeighborhood(source, viewFor(source), { focusEntityId: "system:root" });
  const json = JSON.stringify(packet);
  assert.doesNotMatch(json, /No summary supplied/);
  assert.doesNotMatch(json, /responsibility/);
  assert.equal(packet.snapshot.entities.every(item => item.responsibility === undefined), true);
  assert.equal(ASPECT_PRESET_TARGET.landscape, 1.6);
});
