import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  chooseColumns,
  MAX_OWNER_ASPECT,
  measureC4Grid,
  type C4GridItem,
  type C4GridMetrics,
} from './c4.js';

// Aspect-aware packing (task #30). The default path (no targetAspect) must stay the
// historical min(maxColumns, ceil(sqrt(n))); a target lifts the fixed 3-column cap so a
// dense owner packs toward a screen-shaped box instead of one very tall column.

const CODE = { width: 224, height: 112 };
const items = (n: number): C4GridItem[] =>
  Array.from({ length: n }, (_, index) => ({ id: `code:${String(index).padStart(3, '0')}`, ...CODE }));
const metrics = (targetAspect?: number): C4GridMetrics => ({
  gap: 16,
  paddingLeft: 20,
  paddingRight: 20,
  paddingTop: 96,
  paddingBottom: 20,
  maxColumns: 3,
  ...(targetAspect !== undefined ? { targetAspect } : {}),
});

test('default column formula is exactly min(maxColumns, ceil(sqrt(n)))', () => {
  assert.equal(chooseColumns(items(0), metrics()), 0);
  assert.equal(chooseColumns(items(1), metrics()), 1);
  assert.equal(chooseColumns(items(2), metrics()), 2);
  assert.equal(chooseColumns(items(3), metrics()), 2); // ceil(sqrt(3)) = 2
  assert.equal(chooseColumns(items(9), metrics()), 3); // capped at 3
  assert.equal(chooseColumns(items(50), metrics()), 3); // capped at 3 — the tall-column bug
  assert.equal(chooseColumns(items(139), metrics()), 3);
});

test('a landscape target lifts the 3-column cap toward the requested ratio', () => {
  assert.equal(chooseColumns(items(50), metrics(ASPECT_PRESET_TARGET.landscape)), 7);
  assert.equal(chooseColumns(items(139), metrics(ASPECT_PRESET_TARGET.landscape)), 11);
});

test('portrait keeps the grid narrower/taller than landscape', () => {
  const landscape = chooseColumns(items(50), metrics(ASPECT_PRESET_TARGET.landscape));
  const portrait = chooseColumns(items(50), metrics(ASPECT_PRESET_TARGET.portrait));
  assert.ok(portrait < landscape, `portrait (${portrait}) must use fewer columns than landscape (${landscape})`);
});

test('measureC4Grid packs 50 code cards near 16:10 and far shorter than the capped grid', () => {
  const tall = measureC4Grid(items(50), metrics()); // 3 × 17
  const wide = measureC4Grid(items(50), metrics(ASPECT_PRESET_TARGET.landscape)); // 7 × 8
  assert.equal(tall.columns, 3);
  assert.equal(tall.rows, 17);
  assert.equal(wide.columns, 7);
  assert.equal(wide.rows, 8);
  assert.ok(wide.height < tall.height / 2, `aspect packing must more than halve the height (${wide.height} vs ${tall.height})`);
  const aspect = wide.width / wide.height;
  assert.ok(Math.abs(aspect - ASPECT_PRESET_TARGET.landscape) < 0.15, `packed aspect ${aspect.toFixed(3)} should be near 1.6`);
});

test('column choice is deterministic under shuffled input order', () => {
  const forward = items(50);
  const reversed = [...forward].reverse();
  assert.equal(
    chooseColumns(reversed, metrics(ASPECT_PRESET_TARGET.landscape)),
    chooseColumns(forward, metrics(ASPECT_PRESET_TARGET.landscape)),
  );
  assert.deepEqual(
    measureC4Grid(reversed, metrics(ASPECT_PRESET_TARGET.landscape)),
    measureC4Grid(forward, metrics(ASPECT_PRESET_TARGET.landscape)),
  );
});

test('heterogeneous cell sizes use the max cell and stay order-independent', () => {
  const mixed: C4GridItem[] = [
    { id: 'b', width: 300, height: 90 },
    { id: 'a', width: 200, height: 150 },
    { id: 'c', width: 224, height: 112 },
  ];
  const target = ASPECT_PRESET_TARGET.landscape;
  assert.equal(chooseColumns(mixed, metrics(target)), chooseColumns([...mixed].reverse(), metrics(target)));
});

test('O2 backstop: an owner never packs more extreme than MAX_OWNER_ASPECT (task #37)', () => {
  // The cap is a documented constant, deliberately beyond the landscape/portrait presets.
  assert.equal(MAX_OWNER_ASPECT, 2.2);
  // An absurd target would otherwise pack a small owner far too wide; the clamp pulls the
  // measured box back inside [1/cap, cap] whenever a within-cap column count exists.
  const extremeTarget = 5;
  for (const n of [2, 3, 4, 5, 8, 13]) {
    const grid = measureC4Grid(items(n), metrics(extremeTarget));
    const aspect = grid.width / grid.height;
    assert.ok(
      aspect <= MAX_OWNER_ASPECT + 1e-9 && aspect >= 1 / MAX_OWNER_ASPECT - 1e-9,
      `n=${n}: aspect ${aspect.toFixed(3)} must be clamped within [${(1 / MAX_OWNER_ASPECT).toFixed(3)}, ${MAX_OWNER_ASPECT}]`,
    );
  }
});

test('O2 clamp is inert within the presets — pinned landscape counts are unchanged', () => {
  // 1.6 < cap, so the target-closest choice is already within band and the clamp never fires:
  // the exact column counts pinned above must survive the clamp untouched.
  assert.equal(chooseColumns(items(50), metrics(ASPECT_PRESET_TARGET.landscape)), 7);
  assert.equal(chooseColumns(items(139), metrics(ASPECT_PRESET_TARGET.landscape)), 11);
});

test('presets are frozen and ordered landscape > square > portrait', () => {
  assert.deepEqual(ASPECT_PRESET_TARGET, { landscape: 1.6, portrait: 0.625, square: 1 });
  assert.ok(Object.isFrozen(ASPECT_PRESET_TARGET));
  assert.ok(ASPECT_PRESET_TARGET.landscape > ASPECT_PRESET_TARGET.square);
  assert.ok(ASPECT_PRESET_TARGET.square > ASPECT_PRESET_TARGET.portrait);
});
