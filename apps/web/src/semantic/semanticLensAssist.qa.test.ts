import { describe, expect, it } from 'vitest';
import {
  mayRetargetSemanticLensAssist,
  sampleSemanticLensAssist,
  startSemanticLensAssist,
  updateSemanticLensAssistDesired,
} from './semanticLensAssist';

describe('semantic lens camera-assist acceptance contract', () => {
  it('cannot compound past 68% over twenty inward samples and never alters raw zoom', () => {
    const raw = { x: 10, y: 20, zoom: 1.03 };
    const desired = { x: 110, y: -30, zoom: 1.5 };
    const assist = startSemanticLensAssist('container:web', raw, desired, 1_000, false);
    const maximumDisplacement = Math.hypot(desired.x - raw.x, desired.y - raw.y) * .68;

    for (let sample = 0; sample < 20; sample += 1) {
      const rendered = sampleSemanticLensAssist(assist, raw, 1_000 + sample * 20, .68).camera;
      expect(Math.hypot(rendered.x - raw.x, rendered.y - raw.y))
        .toBeLessThanOrEqual(maximumDisplacement + Number.EPSILON * 100);
      expect(rendered.zoom).toBe(raw.zoom);
    }
  });

  it.each([
    { mobile: false, duration: 260 },
    { mobile: true, duration: 320 },
  ])('eases monotonically to the exact $duration ms endpoint', ({ mobile, duration }) => {
    const raw = { x: 0, y: 0, zoom: .92 };
    const assist = startSemanticLensAssist('container:web', raw, { x: 100, y: 0, zoom: .92 }, 400, mobile);
    const samples = [0, .25, .5, .75, 1].map(fraction =>
      sampleSemanticLensAssist(assist, raw, 400 + duration * fraction, .68));

    expect(samples.map(sample => sample.camera.x)).toEqual([...samples]
      .map(sample => sample.camera.x)
      .sort((left, right) => left - right));
    const increments = samples.slice(1).map((sample, index) => sample.camera.x - samples[index]!.camera.x);
    expect(increments[1]).toBeLessThan(increments[0]!);
    expect(increments[2]).toBeLessThan(increments[1]!);
    expect(increments[3]).toBeLessThan(increments[2]!);
    expect(samples[0]).toMatchObject({ camera: raw, amount: 0, done: false });
    expect(samples.at(-1)).toMatchObject({ camera: { x: 68, y: 0, zoom: .92 }, amount: .68, done: true });
  });

  it('restarts a pre-handoff retarget at the reached camera with no first-frame jump', () => {
    const raw = { x: 0, y: 0, zoom: 1 };
    const reached = { x: 28, y: 12, zoom: 1 };
    expect(mayRetargetSemanticLensAssist(.499)).toBe(true);
    const retargeted = startSemanticLensAssist(
      'container:worker',
      raw,
      { x: 80, y: 80, zoom: 1.04 },
      2_000,
      false,
      reached,
    );
    expect(sampleSemanticLensAssist(retargeted, raw, 2_000, .68).camera).toEqual(reached);
    expect(mayRetargetSemanticLensAssist(.5)).toBe(false);
    expect(mayRetargetSemanticLensAssist(1)).toBe(false);
  });

  it('does not clamp-jump when a retarget starts from an offset already reached beyond its new endpoint', () => {
    const raw = { x: 0, y: 0, zoom: 1 };
    const reached = { x: 40, y: 20, zoom: 1 };
    const retargeted = startSemanticLensAssist(
      'container:worker',
      raw,
      raw,
      3_000,
      false,
      reached,
    );

    expect(sampleSemanticLensAssist(retargeted, raw, 3_000, .68).camera).toEqual(reached);
    const intermediate = sampleSemanticLensAssist(retargeted, raw, 3_130, .68).camera;
    expect(intermediate.x).toBeGreaterThanOrEqual(raw.x);
    expect(intermediate.x).toBeLessThan(reached.x);
    expect(intermediate.y).toBeGreaterThanOrEqual(raw.y);
    expect(intermediate.y).toBeLessThan(reached.y);
    expect(sampleSemanticLensAssist(retargeted, raw, 3_260, .68).camera).toEqual(raw);
  });

  it('updates the safe-center target after raw zoom without restarting the assist clock', () => {
    const raw = { x: 0, y: 0, zoom: 1 };
    const started = startSemanticLensAssist('container:web', raw, { x: 100, y: 0, zoom: 1 }, 4_000, false);
    const reached = sampleSemanticLensAssist(started, raw, 4_130, .68).camera;
    const zoomedRaw = { x: 4, y: 0, zoom: 1.1 };
    const updated = updateSemanticLensAssistDesired(started, { x: 90, y: 10, zoom: 1.1 });
    const afterUpdate = sampleSemanticLensAssist(updated, zoomedRaw, 4_131, .68);

    expect(updated.startedAtMs).toBe(started.startedAtMs);
    expect(afterUpdate.camera.zoom).toBe(zoomedRaw.zoom);
    expect(afterUpdate.camera.x).toBeGreaterThan(zoomedRaw.x);
    expect(Math.abs(afterUpdate.camera.x - reached.x)).toBeLessThan(15);
    expect(sampleSemanticLensAssist(updated, zoomedRaw, 4_260, .68).done).toBe(true);
  });
});
