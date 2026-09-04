import type { AppStoryPlan } from './renderer/goldenC4Scene';
import {
  cumulativeStoryStepOffsets,
  decodeStoryCinematicPosition,
  estimateStoryDuration,
  formatStoryDuration,
  resolveStoryHoldDuration,
  storyCinematicPosition,
  STORY_MAX_FLIGHT_DURATION_MS,
} from './storyPlayback';

export function selectStoryPlan(catalog: readonly AppStoryPlan[], id: string | undefined): AppStoryPlan {
  return catalog.find(story => story.id === id) ?? catalog[0]!;
}

export function storyHoldDurations(plan: AppStoryPlan): number[] {
  return plan.steps.map(step => resolveStoryHoldDuration(step.narration, step.authoredHoldMs));
}

export function storyDurationLabel(plan: AppStoryPlan): string {
  return formatStoryDuration(estimateStoryDuration(storyHoldDurations(plan)));
}

export function storyStepDuration(plan: AppStoryPlan, step: number): number {
  const holds = storyHoldDurations(plan);
  const bounded = Math.max(0, Math.min(plan.steps.length - 1, step));
  return holds[bounded]!;
}

export function storyStepOffset(plan: AppStoryPlan, step: number): number {
  const offsets = cumulativeStoryStepOffsets(storyHoldDurations(plan));
  const bounded = Math.max(0, Math.min(plan.steps.length - 1, step));
  return offsets[bounded]!;
}

export function encodeStoryPosition(
  plan: AppStoryPlan,
  step: number,
  phase: 'flight' | 'arrival' | 'hold',
  elapsedMs: number,
  flightDurationMs = STORY_MAX_FLIGHT_DURATION_MS,
): number {
  return storyCinematicPosition(
    step,
    phase,
    elapsedMs,
    flightDurationMs,
    storyStepDuration(plan, step),
    storyStepOffset(plan, step),
  );
}

export function decodeStoryPosition(plan: AppStoryPlan, step: number, positionMs: number) {
  return decodeStoryCinematicPosition(step, positionMs, storyStepDuration(plan, step), storyStepOffset(plan, step));
}
