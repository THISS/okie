import { describe, expect, it } from 'vitest';
import {
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorTabForEntity,
  inspectorWidthRange,
  inspectorWidthStorageKey,
} from './inspectorPanel';

describe('inspector panel sizing', () => {
  it('defaults to a compact 376–416px pane and uses 360px at the compact breakpoint', () => {
    expect(defaultInspectorWidth(1_200)).toBe(376);
    expect(defaultInspectorWidth(1_440)).toBe(403);
    expect(defaultInspectorWidth(1_920)).toBe(416);
    expect(defaultInspectorWidth(1_060)).toBe(360);
  });

  it('clamps keyboard and pointer resizing to 360px–min(520px, 46vw)', () => {
    expect(inspectorWidthRange(1_200)).toEqual({ min: 360, max: 520 });
    expect(inspectorWidthRange(1_000)).toEqual({ min: 360, max: 460 });
    expect(clampInspectorWidth(200, 1_200)).toBe(360);
    expect(clampInspectorWidth(900, 1_200)).toBe(520);
    expect(clampInspectorWidth(404, 1_200)).toBe(404);
  });

  it('scopes persisted widths to the repository', () => {
    expect(inspectorWidthStorageKey('repo:okie')).toBe('okie:inspector-width:repo:okie');
  });

  it('opens portable code at Source while explicit canvas inspection and unavailable excerpts use Details', () => {
    expect(inspectorTabForEntity(true, 'auto')).toBe('source');
    expect(inspectorTabForEntity(true, 'source')).toBe('source');
    expect(inspectorTabForEntity(true, 'details')).toBe('details');
    expect(inspectorTabForEntity(false, 'source')).toBe('details');
    expect(inspectorTabForEntity(false, 'auto')).toBe('details');
  });
});
