import { describe, expect, it } from 'vitest';
import { relationshipFlowPolicy } from './relationshipFlow';

const base = {
  reducedMotion: false,
  interactionMode: 'view' as const,
  selectedRelationIds: new Set(['relation:selected']),
  storyRelationIds: new Set(['relation:story']),
  storyHoldPlaying: false,
};

describe('relationship flow policy', () => {
  it('animates only the selected relationship during ordinary View inspection', () => {
    expect(relationshipFlowPolicy(base)).toEqual({
      relationIds: new Set(['relation:selected']),
      active: true,
      owner: 'selection',
    });
  });

  it('lets a playing story hold own its traced relationships', () => {
    expect(relationshipFlowPolicy({ ...base, storyHoldPlaying: true })).toEqual({
      relationIds: new Set(['relation:story']),
      active: true,
      owner: 'story',
    });
  });

  it('suppresses selected flow in Edit while leaving static emphasis intact', () => {
    expect(relationshipFlowPolicy({ ...base, interactionMode: 'edit' })).toEqual({
      relationIds: new Set(),
      active: false,
      owner: 'none',
    });
  });

  it('suppresses all particle motion for reduced motion', () => {
    expect(relationshipFlowPolicy({ ...base, reducedMotion: true, storyHoldPlaying: true })).toEqual({
      relationIds: new Set(),
      active: false,
      owner: 'none',
    });
  });
});
