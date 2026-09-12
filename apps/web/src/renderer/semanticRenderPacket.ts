import type { AtlasScene, Camera, ProjectionOverride } from './types';

export type SemanticRenderPacket = {
  revision: number;
  camera: Camera;
  scene: AtlasScene;
  /** Identity token for the React semantic session that owns this projection. */
  semanticSession: object;
  projectionOverride?: ProjectionOverride;
};

export type SemanticRenderFallback = SemanticRenderPacket;

function sameCamera(left: Camera, right: Camera): boolean {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

/**
 * A semantic input updates camera imperatively before React has committed its
 * matching lens projection. Retain the packet geometry until React acknowledges
 * its scene and session; intervening pans still use the latest live camera.
 */
export function semanticRenderFrame(
  pending: SemanticRenderPacket | undefined,
  liveCamera: Camera,
  fallback: SemanticRenderFallback,
): { frame: SemanticRenderPacket; acknowledged: boolean } {
  const acknowledged = Boolean(pending
    && pending.scene === fallback.scene
    && pending.semanticSession === fallback.semanticSession);
  if (!pending || acknowledged) return { frame: fallback, acknowledged };
  // Keep the latest semantic geometry paired with every live camera until
  // React has committed the same session. This covers an assist/pan frame
  // arriving before the semantic state commit without reviving old geometry.
  return { frame: { ...pending, camera: sameCamera(pending.camera, liveCamera) ? pending.camera : { ...liveCamera } }, acknowledged: false };
}
