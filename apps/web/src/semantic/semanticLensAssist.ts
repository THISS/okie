import type { Camera } from '../renderer/types';
import { SEMANTIC_LENS_POLICY } from './semanticLens';

export type SemanticLensAssist = {
  targetId: string;
  startedAtMs: number;
  durationMs: number;
  desired: Camera;
  sourceOffset: { x: number; y: number };
};

export function startSemanticLensAssist(
  targetId: string,
  rawCamera: Camera,
  desired: Camera,
  nowMs: number,
  mobile: boolean,
  reachedCamera: Camera = rawCamera,
): SemanticLensAssist {
  return {
    targetId,
    startedAtMs: nowMs,
    durationMs: mobile ? SEMANTIC_LENS_POLICY.mobileAssistMs : SEMANTIC_LENS_POLICY.desktopAssistMs,
    desired: { ...desired },
    sourceOffset: { x: reachedCamera.x - rawCamera.x, y: reachedCamera.y - rawCamera.y },
  };
}

export function updateSemanticLensAssistDesired(assist: SemanticLensAssist, desired: Camera): SemanticLensAssist {
  return { ...assist, desired: { ...desired } };
}

function easeOutCubic(value: number) {
  const inverse = 1 - Math.max(0, Math.min(1, value));
  return 1 - inverse * inverse * inverse;
}

export function sampleSemanticLensAssist(
  assist: SemanticLensAssist,
  rawCamera: Camera,
  nowMs: number,
  requestedBlend: number,
): { camera: Camera; amount: number; done: boolean } {
  const elapsed = Math.max(0, nowMs - assist.startedAtMs);
  const timeProgress = Math.min(1, elapsed / Math.max(1, assist.durationMs));
  const eased = easeOutCubic(timeProgress);
  const amount = Math.min(SEMANTIC_LENS_POLICY.maxCenterBlend, Math.max(0, requestedBlend)) * eased;
  const base = {
    x: rawCamera.x + assist.sourceOffset.x * (1 - eased),
    y: rawCamera.y + assist.sourceOffset.y * (1 - eased),
  };
  let x = base.x + (assist.desired.x - base.x) * amount;
  let y = base.y + (assist.desired.y - base.y) * amount;
  const desiredDelta = { x: assist.desired.x - rawCamera.x, y: assist.desired.y - rawCamera.y };
  const renderedDelta = { x: x - rawCamera.x, y: y - rawCamera.y };
  const desiredDistance = Math.hypot(desiredDelta.x, desiredDelta.y);
  const renderedDistance = Math.hypot(renderedDelta.x, renderedDelta.y);
  const continuityAllowance = Math.hypot(assist.sourceOffset.x, assist.sourceOffset.y) * (1 - eased);
  const maxDistance = desiredDistance * SEMANTIC_LENS_POLICY.maxCenterBlend + continuityAllowance;
  if (renderedDistance > maxDistance && renderedDistance > 0) {
    const scale = maxDistance / renderedDistance;
    x = rawCamera.x + renderedDelta.x * scale;
    y = rawCamera.y + renderedDelta.y * scale;
  }
  // User zoom is authoritative. A future settled correction may use at most 6%; assist itself uses 0%.
  return { camera: { x, y, zoom: rawCamera.zoom }, amount, done: timeProgress >= 1 };
}

export function mayRetargetSemanticLensAssist(progress: number) {
  return progress < SEMANTIC_LENS_POLICY.retargetProgressLimit;
}
