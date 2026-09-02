import assert from 'node:assert/strict';
import test from 'node:test';
import { buildC4ProjectionBundle } from '@okie/architecture';
import { C4_BOUNDARY_STROKE_ALPHA, compileC4Scene } from './compile-c4.js';
import { goldenSnapshot } from './golden-fixture.js';

const OLD_LINE_ALPHA = 0.1;

test('CLA-45: nested owner shells compile above the old 0.1 line alpha', () => {
  assert.ok(C4_BOUNDARY_STROKE_ALPHA > OLD_LINE_ALPHA);

  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, bundle, { sceneId: 'scene:golden-c4', revision: 7 });
  const shells: number[] = [];

  for (const object of compiled.scene.objects) {
    for (const representation of object.representations) {
      for (const primitive of representation.primitives) {
        if (primitive.kind !== 'roundedRect' || primitive.fill[3] >= 1) continue;
        assert.ok(primitive.stroke, `${object.id} owner shell must stroke its nested bounds`);
        assert.equal(primitive.stroke.color[3], C4_BOUNDARY_STROKE_ALPHA);
        shells.push(primitive.stroke.color[3]);
      }
    }
  }

  assert.ok(shells.length > 0, 'golden C4 scene must include nested owner shells');
  assert.ok(shells.every(alpha => alpha > OLD_LINE_ALPHA));
});
