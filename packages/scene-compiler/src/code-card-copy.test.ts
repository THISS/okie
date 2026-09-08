import assert from 'node:assert/strict';
import test from 'node:test';
import { goldenSnapshot } from './golden-fixture.js';
import {
  codeCardCopy,
  codeCardKicker,
  codeCardLineRange,
  codeCardSignature,
  codeKindBadge,
  formatCodeLineRange,
} from './code-card-copy.js';

test('function excerpt yields FN badge, line range, and signature without the path', () => {
  const source = {
    name: 'selectScopedView()',
    source: 'packages/architecture/src/normalized.ts',
    sourceRefs: [{
      path: 'packages/architecture/src/normalized.ts',
      symbol: 'selectScopedView',
      startLine: 600,
      endLine: 640,
    }],
    sourceExcerpts: [{
      startLine: 600,
      endLine: 605,
      lines: [
        'export function selectScopedView(state: NormalizedArchitecture, viewId: string, rootEntityId: string): ArchitectureView {',
        '  const view = selectArchitectureView(state, viewId);',
      ],
    }],
  };
  const copy = codeCardCopy(source);
  assert.equal(codeKindBadge(source), 'FN');
  assert.equal(copy.kicker, 'FN · 600–640');
  assert.equal(copy.description, source.sourceExcerpts[0]!.lines[0]);
  assert.equal(copy.descriptionMode, 'word');
  assert.equal(copy.kicker.includes('normalized.ts'), false);
  assert.equal(copy.description?.includes('packages/'), false);
});

test('interface, class, type, and rust kinds map to short badges', () => {
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['export interface ArchitectureEntity {'] }] }), 'INTERFACE');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['export class Canvas2DRenderer implements AtlasRenderer {'] }] }), 'CLASS');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['export type NavigationState = {'] }] }), 'TYPE');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['export const SOURCE_EXCERPT_LIMITS = {'] }] }), 'CONST');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['pub fn hit_test('] }] }), 'FN');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['pub struct SceneSnapshot {'] }] }), 'STRUCT');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['pub enum ProtocolError {'] }] }), 'ENUM');
  assert.equal(codeKindBadge({ sourceExcerpts: [{ lines: ['pub trait AtlasRenderer {'] }] }), 'TRAIT');
  assert.equal(codeKindBadge({ name: 'createRenderer()' }), 'FN');
  assert.equal(codeKindBadge({ name: 'SceneSnapshot::validate()' }), 'FN');
  assert.equal(codeKindBadge({ name: 'App' }), 'SOURCE');
});

test('docstring wins over the following signature when the excerpt starts with one', () => {
  const source = {
    name: 'compileScene()',
    sourceExcerpts: [{
      startLine: 8,
      endLine: 12,
      lines: [
        '/** Compile a semantic snapshot into renderer objects. */',
        'export function compileScene(snapshot: SceneSnapshot): CompiledScene {',
      ],
    }],
  };
  assert.equal(codeCardSignature(source), 'Compile a semantic snapshot into renderer objects.');
  assert.equal(codeKindBadge(source), 'FN');
});

test('line range prefers the source-ref span and formats a single line', () => {
  assert.equal(formatCodeLineRange(12, 12), '12');
  assert.equal(formatCodeLineRange(12, 18), '12–18');
  assert.equal(codeCardLineRange({ sourceExcerpts: [{ startLine: 4, endLine: 9 }] }), '4–9');
  assert.equal(codeCardKicker({ name: 'helper()' }), 'FN');
});

test('golden L4 selectScopedView copy drops the parent filepath', () => {
  const entity = goldenSnapshot.entities.find(candidate => candidate.id === 'code:model-scoping:select-scoped-view')!;
  const copy = codeCardCopy(entity);
  const path = entity.sourceRefs[0]!.path;
  assert.equal(copy.kicker.startsWith('FN · '), true);
  assert.ok(copy.description?.startsWith('export function selectScopedView('));
  assert.equal(copy.kicker.includes(path), false);
  assert.equal(copy.description?.includes(path), false);
  assert.equal(copy.description?.includes('normalized.ts'), false);
});
