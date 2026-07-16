import { describe, expect, it } from 'vitest';
import { canvasAnimationPolicy } from './canvasAnimationPolicy';

const selectedFlow = {
  reducedMotion: false,
  animationActive: false,
  flowActive: true,
  pointerInteraction: 'idle' as const,
};

describe('main canvas animation policy', () => {
  it('keeps selected relationship flow continuous throughout a camera pan', () => {
    expect(canvasAnimationPolicy(selectedFlow)).toEqual({ continuous: true, animateFlow: true });
    expect(canvasAnimationPolicy({ ...selectedFlow, pointerInteraction: 'camera-pan' })).toEqual({
      continuous: true,
      animateFlow: true,
    });
  });

  it('keeps story flow continuous throughout a camera pan', () => {
    expect(canvasAnimationPolicy({
      ...selectedFlow,
      animationActive: true,
      pointerInteraction: 'camera-pan',
    })).toEqual({ continuous: true, animateFlow: true });
  });

  it('freezes relationship flow while an authoring route is manipulated', () => {
    expect(canvasAnimationPolicy({ ...selectedFlow, pointerInteraction: 'authoring-drag' })).toEqual({
      continuous: false,
      animateFlow: false,
    });
  });

  it('keeps reduced-motion and inactive Edit selection states static', () => {
    expect(canvasAnimationPolicy({ ...selectedFlow, reducedMotion: true })).toEqual({
      continuous: false,
      animateFlow: false,
    });
    expect(canvasAnimationPolicy({ ...selectedFlow, flowActive: false })).toEqual({
      continuous: false,
      animateFlow: false,
    });
  });
});
