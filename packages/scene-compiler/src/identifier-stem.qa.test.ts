import assert from 'node:assert/strict';
import test from 'node:test';
import { BAND_COST_HANG_GUARD_ENTITIES } from './band-cost-curve.js';
import {
  C4_LABEL_TITLE_SHRINK_RATIO,
  C4_PRESENTATION_AT_FOCUS,
  c4TitleFitFloor,
} from './compile-c4.js';
import { fitDisplayText, fitDisplayTextAtSize, truncateDisplayText } from './display-text.js';

test('CLA-112: hang-guard stays 2000', () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
  assert.equal(C4_LABEL_TITLE_SHRINK_RATIO, 0.65);
});

test('CLA-112: last-segment fallback never left-stems a filename', () => {
  const slashed = truncateDisplayText('src/diagnostics.rs', 10, 'identifier');
  const bare = truncateDisplayText('isolateNeighborhood.ts', 12, 'identifier');
  assert.equal(slashed, 'diag…cs.rs');
  assert.notEqual(slashed, '…ics.rs');
  assert.match(slashed, /^[^…]/u);
  assert.equal(bare, 'isolat…od.ts');
  assert.notEqual(bare, '…rhood.ts');
  assert.match(bare, /\.ts$/u);
});

test('CLA-112: titleFloor shrink still runs before this truncation', () => {
  const name = 'src/diagnostics.rs';
  const authored = C4_PRESENTATION_AT_FOCUS.component.titleFontSize;
  const floor = c4TitleFitFloor('component', authored, 12);
  const fullWidth = fitDisplayText(name, 10_000, authored, 'identifier', 'sans-semibold');
  assert.equal(fullWidth, name);
  const maxWidth = 90;
  const truncatedAtAuthored = fitDisplayText(name, maxWidth, authored, 'identifier', 'sans-semibold');
  const fitted = fitDisplayTextAtSize(name, maxWidth, authored, floor, 'identifier', 'sans-semibold');
  assert.ok(fitted.fontSize < authored);
  assert.ok(fitted.fontSize >= floor - 1e-9);
  if (truncatedAtAuthored.includes('…')) {
    assert.ok(fitted.content.length >= truncatedAtAuthored.length);
  }
  assert.notEqual(fitted.content, '…ics.rs');
});
