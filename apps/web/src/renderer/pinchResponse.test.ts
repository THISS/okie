import { describe, expect, it } from 'vitest';
import { zoomCameraAt, zoomCameraByFactor } from './cameraController';
import { chromeTrackpadPinch } from './wheelFixtures';
import { createWheelIntentClassifier, wheelZoomFactor } from './wheelIntent';

/**
 * CLA-326 before/after: replay the (modelled) Chrome trackpad pinch — fingers
 * spread ≈ 2× — through the old path (every wheel through zoomCameraAt's
 * mouse-notch gain) and the new path (classified pinch → wheelZoomFactor).
 */
describe('trackpad pinch responsiveness', () => {
  const viewport = { width: 1200, height: 800 };
  const start = { x: 0, y: 0, zoom: 1 };

  function replayOld() {
    return chromeTrackpadPinch.reduce(
      (camera, event) => zoomCameraAt(camera, 600, 400, viewport, event.deltaY),
      start,
    );
  }

  function replayNew() {
    const classifier = createWheelIntentClassifier();
    return chromeTrackpadPinch.reduce((camera, event) => {
      const intent = classifier.classify(event);
      if (intent.kind !== 'zoom') throw new Error('pinch must classify as zoom');
      return zoomCameraByFactor(camera, 600, 400, viewport, wheelZoomFactor(intent));
    }, start);
  }

  it('reaches ≈ the finger scale on the new path, while the old path falls well short', () => {
    const before = replayOld().zoom;
    const after = replayNew().zoom;
    // Old: exp(69.3 × 0.0012) ≈ 1.087×. New: exp(69.3 × 0.01) ≈ 2.0×.
    expect(before).toBeCloseTo(1.087, 2);
    expect(after).toBeCloseTo(2, 1);
    expect(Math.log(after) / Math.log(before)).toBeGreaterThan(8);
  });
});
