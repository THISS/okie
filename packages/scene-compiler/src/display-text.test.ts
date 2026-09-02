import assert from 'node:assert/strict';
import test from 'node:test';
import { displayGlyphCapacity, fitDisplayText, fitDisplayTextAtSize, truncateDisplayText } from './display-text.js';

test('display text truncation is Unicode-safe and ends prose at a word boundary', () => {
  assert.equal(truncateDisplayText('Über façade compiler pipeline', 14), 'Über façade…');
  assert.equal(truncateDisplayText('unbreakable', 6), '…');
});

test('identifier titles retain a useful semantic prefix', () => {
  assert.equal(truncateDisplayText('createNavigationHistoryController()', 18, 'identifier'), 'createNavigationH…');
});

test('very short display capacities are deterministic', () => {
  assert.equal(truncateDisplayText('architecture', 0), '');
  assert.equal(truncateDisplayText('architecture', 1), '…');
  assert.equal(truncateDisplayText('architecture', 2), '…');
});

test('source paths retain their repository area and filename with a middle ellipsis', () => {
  const path = 'packages/architecture/src/normalized.ts';
  assert.equal(truncateDisplayText(path, 25, 'path'), 'packages/…/normalized.ts');
  assert.equal(truncateDisplayText(path, 20, 'path'), '…/src/normalized.ts');
  assert.equal(truncateDisplayText(path, 8, 'path'), '…ized.ts');
});

test('fixed-atlas capacity and fitting require no text measurement', () => {
  assert.equal(displayGlyphCapacity(100, 10), 16);
  assert.equal(fitDisplayText('Architecture compiler pipeline', 100, 10), 'Architecture…');
});

test('scoped npm identifiers keep the package tail instead of a brutal prefix', () => {
  assert.equal(truncateDisplayText('@fontsource/ibm-plex-sans', 16, 'identifier'), '…/ibm-plex-sans');
  assert.equal(truncateDisplayText('@fontsource/ibm-plex-sans', 24, 'identifier'), '…/ibm-plex-sans');
  assert.equal(truncateDisplayText('@fontsource/ibm-plex-sans', 25, 'identifier'), '@fontsource/ibm-plex-sans');
  const fitted = fitDisplayText('@fontsource/ibm-plex-sans', 100, 12, 'identifier', 'sans-semibold');
  assert.match(fitted, /ibm-plex-sans$/u);
  assert.equal(fitted.includes('@fontsource/ibm-') && !fitted.includes('plex-sans'), false);
});

test('title shrink-to-fit prefers the full name down to the truncation floor', () => {
  const wide = fitDisplayTextAtSize('@fontsource/ibm-plex-sans', 400, 26.67, 16, 'identifier', 'sans-semibold');
  assert.equal(wide.content, '@fontsource/ibm-plex-sans');
  assert.equal(wide.fontSize, 26.67);

  const tight = fitDisplayTextAtSize('@fontsource/ibm-plex-sans', 180, 26.67, 16, 'identifier', 'sans-semibold');
  assert.equal(tight.fontSize, 16);
  assert.match(tight.content, /ibm-plex-sans$/u);
  assert.ok(tight.content.includes('…'));
});
