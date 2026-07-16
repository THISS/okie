export type CanvasPointerInteraction = 'idle' | 'camera-pan' | 'authoring-drag';

export type CanvasAnimationPolicyInput = {
  reducedMotion: boolean;
  animationActive: boolean;
  flowActive: boolean;
  pointerInteraction: CanvasPointerInteraction;
};

export type CanvasAnimationPolicy = {
  continuous: boolean;
  animateFlow: boolean;
};

/** Camera movement preserves playback; only authoring manipulation freezes the relationship layer. */
export function canvasAnimationPolicy(input: CanvasAnimationPolicyInput): CanvasAnimationPolicy {
  const motionAllowed = !input.reducedMotion && input.pointerInteraction !== 'authoring-drag';
  return {
    continuous: motionAllowed && (input.animationActive || input.flowActive),
    animateFlow: motionAllowed && input.flowActive,
  };
}
