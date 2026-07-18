import { describe, expect, it } from 'vitest';
import { readDemoQuery } from './query';

describe('readDemoQuery', () => {
  it('uses deterministic defaults', () => {
    expect(readDemoQuery('')).toEqual({ fixture: 'okie', seed: 42, backend: 'auto', warnings: [] });
  });

  it.each(['auto', 'canvas2d', 'webgpu', 'webgl2'] as const)('accepts the explicit %s backend control', backend => {
    expect(readDemoQuery(`?fixture=okie&seed=7&backend=${backend}`)).toMatchObject({ fixture: 'okie', seed: 7, backend });
  });

  it('accepts the deterministic stress fixture', () => {
    expect(readDemoQuery('?fixture=stress&seed=42&backend=auto')).toMatchObject({ fixture: 'stress', seed: 42, backend: 'auto', warnings: [] });
  });

  it('accepts the scanned-snapshot fixture', () => {
    const root = readDemoQuery('?fixture=scan');
    expect(root).toMatchObject({ fixture: 'scan', seed: 42, backend: 'auto', warnings: [] });
    expect(root.scanRepo).toBeUndefined();
  });

  it('selects a per-repo scan via fixture=scan:<slug> without warnings', () => {
    const result = readDemoQuery('?fixture=scan:colinhacks__zod');
    expect(result).toMatchObject({ fixture: 'scan', scanRepo: 'colinhacks__zod', warnings: [] });
  });

  it('treats an empty scan:<slug> selector as the root self-scan', () => {
    const result = readDemoQuery('?fixture=scan:');
    expect(result.fixture).toBe('scan');
    expect(result.scanRepo).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('bounds and reports unsupported values', () => {
    const result = readDemoQuery('?fixture=other&seed=nope&backend=metal');
    expect(result).toMatchObject({ fixture: 'okie', seed: 42, backend: 'auto' });
    expect(result.warnings).toHaveLength(3);
  });
});
