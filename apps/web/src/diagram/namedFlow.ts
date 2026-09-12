import type { ArchitectureStory } from '@okie/architecture';
import type { AppStoryPlan } from '../renderer/goldenC4Scene';

/** Host playback renames semantic durationMs; never spread its private fields into the schema. */
export function architectureStoryFromAppPlan(plan: AppStoryPlan): ArchitectureStory {
  return {
    schemaVersion: 1, id: plan.id, snapshotId: plan.snapshotId, viewId: plan.viewId, title: plan.title,
    steps: plan.steps.map(step => ({
      id: step.id, title: step.title, narration: step.narration,
      focusEntityIds: [...step.focusEntityIds], traceRelationIds: [...step.traceRelationIds],
      reveal: step.reveal, sourceRefs: step.sourceRefs.map(source => ({ ...source })),
      ...(step.authoredHoldMs === undefined ? {} : { durationMs: step.authoredHoldMs }),
    })),
  };
}

export function optionalDiagramResult<T>(compile: () => T): { artifact: T; error?: undefined } | { artifact?: undefined; error: string } {
  try { return { artifact: compile() }; }
  catch { return { error: 'This named flow could not be compiled from its captured evidence. Return to Main to continue exploring the atlas.' }; }
}
