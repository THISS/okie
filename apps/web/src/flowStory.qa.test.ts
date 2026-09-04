import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isolateNeighborhoodIds, type IsolateNeighborhoodEntity } from './isolateNeighborhood';
import { selectStoryPlan, storyDurationLabel } from './storyCatalog';
import type { AppStoryPlan } from './renderer/goldenC4Scene';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const scan = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');

const overview: AppStoryPlan = {
  id: 'story:demo:overview',
  snapshotId: 'snapshot:demo',
  viewId: 'view:demo',
  title: 'Demo overview',
  steps: [{
    id: 'step:context',
    title: 'Start',
    narration: 'System context.',
    focusEntityIds: ['system:demo'],
    traceRelationIds: [],
    reveal: 'context',
    sourceRefs: [],
  }],
};

const flow: AppStoryPlan = {
  id: 'story:demo:paste-a-repo',
  snapshotId: 'snapshot:demo',
  viewId: 'view:demo',
  title: 'Demo: Paste a repository',
  steps: [{
    id: 'step:paste-scan',
    title: 'createScanJobRunner',
    narration: 'createScanJobRunner is a code in this flow (the scan job that publishes the atlas).',
    focusEntityIds: ['code:scan-service:create-scan-job-runner'],
    traceRelationIds: [],
    reveal: 'code',
    sourceRefs: [],
  }],
};

describe('CLA-77 user-flow stories', () => {
  it('loads a published catalog without replacing the overview story.json boot', () => {
    expect(scan).toContain('loadStories');
    expect(scan).toContain('stories.json');
    expect(scan).toContain('compilePublishedStories');
    expect(app).toContain('storyCatalog');
    expect(app).toContain('data-story-catalog-count={storyCatalog.length}');
    expect(app).toContain('data-testid={plan.id === defaultStory.id ? \'story-launch-overview\' : \'story-launch-flow\'}');
    expect(app).toContain('startOverviewTour: () => setStep(0, true, \'push\', defaultStory)');
    expect(app).toContain('hasStory: (id: string) => storyCatalog.some(plan => plan.id === id)');
  });

  it('keeps overview as the default selectable story', () => {
    expect(selectStoryPlan([overview, flow], undefined).id).toBe(overview.id);
    expect(selectStoryPlan([overview, flow], flow.id).id).toBe(flow.id);
    expect(selectStoryPlan([overview, flow], 'story:missing').id).toBe(overview.id);
    expect(storyDurationLabel(overview)).toMatch(/\d/);
  });

  it('lifts isolate from a code flow step to the file-component neighborhood (CLA-55)', () => {
    const entities: IsolateNeighborhoodEntity[] = [
      { id: 'container:server', detail: 'container', parentId: 'system:okie' },
      { id: 'component:scan-service', detail: 'component', parentId: 'container:server' },
      { id: 'code:scan-service:create-scan-job-runner', detail: 'code', parentId: 'component:scan-service' },
      { id: 'code:scan-service:publish', detail: 'code', parentId: 'component:scan-service' },
    ];
    const isolated = isolateNeighborhoodIds(entities, flow.steps[0]!.focusEntityIds, { liftCodeStoryFocus: true });
    expect(isolated).toEqual([
      'component:scan-service',
      'code:scan-service:create-scan-job-runner',
      'code:scan-service:publish',
    ]);
    expect(isolated.length).toBeGreaterThan(1);
    expect(isolated).not.toEqual(flow.steps[0]!.focusEntityIds);
  });
});
