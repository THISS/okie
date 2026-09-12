import type { Camera } from './types';

export type InspectorFlightFrameSink = {
  /** Stop gesture-owned writers and return the camera from which the flight must start. */
  begin(): Camera;
  /** Paint an animation sample without publishing React camera state. */
  render(camera: Camera): void;
};

export type InspectorFlightFrameSinkInput = {
  readLiveCamera(): Camera;
  cancelPublishedCamera(): void;
  cancelSemanticZoomSettle(): void;
  cancelSemanticAssist(): void;
  cancelSettleGlide(): void;
  cancelGestureSettles(): void;
  clearPendingRawAdoption(): void;
  rebaseRawCamera(camera: Camera): void;
  applyFrame(camera: Camera): void;
};

/**
 * Inspector flights own camera writes after a click. Clear any wheel, pinch, pan,
 * or deferred publisher writer before streaming frames into the canvas.
 */
export function createInspectorFlightFrameSink(input: InspectorFlightFrameSinkInput): InspectorFlightFrameSink {
  return {
    begin() {
      input.cancelPublishedCamera();
      input.cancelSemanticZoomSettle();
      input.cancelSemanticAssist();
      input.cancelSettleGlide();
      input.cancelGestureSettles();
      input.clearPendingRawAdoption();
      const camera = { ...input.readLiveCamera() };
      input.rebaseRawCamera(camera);
      return camera;
    },
    render(camera) {
      input.applyFrame(camera);
    },
  };
}
