import assert from "node:assert/strict";
import test from "node:test";
import {
  ASPECT_PRESET_TARGET,
  C4_BAND_FOCUS_ZOOM,
  C4_INTRINSIC_LAYOUT,
  measureC4Grid,
} from "./c4.js";
import {
  computeContainmentLayout,
  containmentSizeByEntityId,
  type ContainmentEntity,
} from "./containment-layout.js";

function entity(id: string, kind: ContainmentEntity["kind"], parentId?: string): ContainmentEntity {
  return { id, kind, ...(parentId ? { parentId } : {}) };
}

function tree(): ContainmentEntity[] {
  const entities: ContainmentEntity[] = [
    entity("system:root", "softwareSystem"),
    entity("container:a", "container", "system:root"),
    entity("container:b", "container", "system:root"),
  ];
  for (const container of ["container:a", "container:b"] as const) {
    for (let file = 0; file < 4; file += 1) {
      const componentId = `component:${container}:${file}`;
      entities.push(entity(componentId, "component", container));
      for (let code = 0; code < 8; code += 1) {
        entities.push(entity(`code:${container}:${file}:${code}`, "code", componentId));
      }
    }
  }
  return entities;
}

test("CLA-81: containment sizes are deterministic and independent of entity insertion order", () => {
  const entities = tree();
  const reversed = [...entities].reverse();
  const target = ASPECT_PRESET_TARGET.landscape;
  assert.deepEqual(
    containmentSizeByEntityId(reversed, { targetAspect: target }),
    containmentSizeByEntityId(entities, { targetAspect: target }),
  );
});

test("CLA-81: every entity gets a layout rect from containment, no enrichment required", () => {
  const layout = computeContainmentLayout(tree(), { targetAspect: ASPECT_PRESET_TARGET.landscape });
  for (const entity of tree()) {
    const bounds = layout[entity.id];
    assert.ok(bounds, `missing rect for ${entity.id}`);
    assert.ok(bounds.width > 1 && bounds.height > 1, `${entity.id} must not be a 1×1 placeholder`);
  }
});

test("CLA-81: a container sized from childCounts matches the full nested footprint", () => {
  const full = tree();
  const slim = full.filter(entity => entity.kind === "softwareSystem" || entity.kind === "container");
  const childCounts: Record<string, number> = {};
  for (const entity of full) {
    if (!entity.parentId) continue;
    childCounts[entity.parentId] = (childCounts[entity.parentId] ?? 0) + 1;
  }
  const unpublished = full.filter(entity => entity.kind === "component");
  const fromSlim = containmentSizeByEntityId([...slim, ...unpublished], {
    childCounts,
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const fromFull = containmentSizeByEntityId(full, { targetAspect: ASPECT_PRESET_TARGET.landscape });
  assert.equal(fromSlim["container:a"]?.width, fromFull["container:a"]?.width);
  assert.equal(fromSlim["container:a"]?.height, fromFull["container:a"]?.height);
  assert.ok((fromSlim["container:a"]?.width ?? 0) > (fromSlim["system:root"] ? 0 : 1));
});

test("CLA-81: childCount padding uses the intrinsic code-leaf grid, not invented copy", () => {
  const owner: ContainmentEntity[] = [
    entity("component:file", "component"),
  ];
  const sizes = containmentSizeByEntityId(owner, {
    childCounts: { "component:file": 8 },
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const leaf = {
    width: C4_INTRINSIC_LAYOUT.leaf.code.width / C4_BAND_FOCUS_ZOOM.code,
    height: C4_INTRINSIC_LAYOUT.leaf.code.height / C4_BAND_FOCUS_ZOOM.code,
  };
  const items = Array.from({ length: 8 }, (_, index) => ({ id: `code:${index}`, ...leaf }));
  const measured = measureC4Grid(items, {
    gap: (C4_INTRINSIC_LAYOUT.gap + 32) / C4_BAND_FOCUS_ZOOM.code,
    paddingLeft: C4_INTRINSIC_LAYOUT.sidePadding / C4_BAND_FOCUS_ZOOM.code,
    paddingRight: C4_INTRINSIC_LAYOUT.sidePadding / C4_BAND_FOCUS_ZOOM.code,
    paddingTop: C4_INTRINSIC_LAYOUT.header.component / C4_BAND_FOCUS_ZOOM.code,
    paddingBottom: C4_INTRINSIC_LAYOUT.bottomPadding / C4_BAND_FOCUS_ZOOM.code,
    maxColumns: 3,
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  assert.equal(sizes["component:file"]?.width, measured.width);
  assert.equal(sizes["component:file"]?.height, measured.height);
});
