import { describe, expect, it } from 'vitest';
import { buildC4ProjectionBundle, validateStory } from '@okie/architecture';
import { compileC4DynamicFlowArtifact, goldenSnapshot, goldenStory, goldenView } from '@okie/scene-compiler';
import { compileAppStoryPlan } from '../renderer/goldenC4Scene';
import { architectureStoryFromAppPlan, optionalDiagramResult } from './namedFlow';

describe('published named flow conversion', () => {
  it('roundtrips authored timing without leaking host fields and preserves sequence', () => {
    const semantic = { ...goldenStory, steps: goldenStory.steps.map((step, i) => ({ ...step, durationMs: 1200 + i * 100 })) };
    const plan = compileAppStoryPlan(goldenSnapshot, goldenView, semantic);
    const before = JSON.stringify(plan);
    expect(() => compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, { schemaVersion: 1, ...plan }, buildC4ProjectionBundle(goldenSnapshot, { rootEntityId: goldenView.rootEntityId }))).toThrow('authoredHoldMs');
    const story = architectureStoryFromAppPlan(plan);
    expect(validateStory(goldenSnapshot, goldenView, story)).toEqual([]);
    expect(story.steps.map(step => step.durationMs)).toEqual(semantic.steps.map(step => step.durationMs));
    expect(story.steps.map(step => step.traceRelationIds)).toEqual(plan.steps.map(step => step.traceRelationIds));
    const result = optionalDiagramResult(() => compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, story, buildC4ProjectionBundle(goldenSnapshot, { rootEntityId: goldenView.rootEntityId })));
    expect(result.error).toBeUndefined();
    expect(result.artifact?.interactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).toBe(before);
  });
  it('contains invalid optional compilation as a diagram error instead of throwing into App', () => {
    const result = optionalDiagramResult(() => { throw new Error('invalid private schema field'); });
    expect(result.artifact).toBeUndefined();
    expect(result.error).toContain('Return to Main');
  });
});
