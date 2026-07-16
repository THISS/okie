import { describe, expect, it } from 'vitest';
import { mayRetargetSemanticLensAssist, sampleSemanticLensAssist, startSemanticLensAssist } from './semanticLensAssist';

describe('semantic lens camera assist', () => {
  it('eases for the authored duration, never compounds beyond 68%, and preserves raw zoom', () => {
    const raw = { x: 0, y: 0, zoom: .9 };
    const assist = startSemanticLensAssist('container:web', raw, { x: 100, y: 0, zoom: 2 }, 1_000, false);
    expect(sampleSemanticLensAssist(assist, raw, 1_000, .68).camera).toEqual(raw);
    const middle = sampleSemanticLensAssist(assist, raw, 1_130, .68);
    expect(middle.camera.x).toBeGreaterThan(0);
    expect(middle.camera.x).toBeLessThanOrEqual(68);
    expect(middle.camera.zoom).toBe(.9);
    const done = sampleSemanticLensAssist(assist, raw, 1_260, .68);
    expect(done).toMatchObject({ amount: .68, done: true });
    expect(done.camera).toEqual({ x: 68, y: 0, zoom: .9 });
  });

  it('retargets only before the canonical ownership handoff and starts from the reached view', () => {
    expect(mayRetargetSemanticLensAssist(.49)).toBe(true);
    expect(mayRetargetSemanticLensAssist(.5)).toBe(false);
    const assist = startSemanticLensAssist(
      'container:worker',
      { x: 0, y: 0, zoom: 1 },
      { x: 0, y: 100, zoom: 1 },
      0,
      true,
      { x: 20, y: 10, zoom: 1 },
    );
    expect(sampleSemanticLensAssist(assist, { x: 0, y: 0, zoom: 1 }, 0, .68).camera).toEqual({ x: 20, y: 10, zoom: 1 });
    expect(assist.durationMs).toBe(320);
  });
});
