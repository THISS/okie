import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cameraWorldRect,
  sliceArchitectureNeighborhood,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import { denseNeighborhoodSnapshot } from '@okie/scene-compiler';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from '../entityExplorer';
import { createC4Scene, createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { scanCompileFocusForBand } from '../renderer/lazyBandCompile';
import { compileScanNeighborhoodFixture, SCAN_RESIDENT_NODES_PER_BAND } from '../renderer/scanFixture';
import { idleSemanticLensSession, semanticLensSessionVisibleEntityIds } from './semanticLens';
import {
  frameProjectionScope,
  frameVisibleProjection,
  projectedEntitiesFitSafeViewport,
  residentVisibleProjectionEntityIds,
  semanticLevelSession,
} from './semanticLensEngine';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

/** Inspector-open desktop chrome, matching the atlas crop used when shooting L1. */
const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

const GOLDEN_L1_IDS = [
  'actor:developer',
  'external:browser-graphics',
  'external:source-repository',
  'system:okie',
] as const;

describe('CLA-44: Fit frames the visible projection, not the root scope', () => {
  it('golden L1 Fit shows every painted context peer after one Fit', () => {
    const scene = createGoldenC4Scene();
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    expect(visibleIds).toEqual([...GOLDEN_L1_IDS].sort());
    expect(visibleIds).toEqual([...scene.projection!.entityIdsByDetail.context].sort());

    const camera = frameVisibleProjection(scene, visibleIds, 'context', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(projectedEntitiesFitSafeViewport(
      scene,
      visibleIds,
      'context',
      camera!,
      viewport,
      chromeSafeArea,
    )).toBe(true);
  });

  it('root-scope readable Fit leaves L1 context peers outside the safe viewport', () => {
    const scene = createGoldenC4Scene();
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    const cropped = frameProjectionScope(
      scene,
      'system:okie',
      'context',
      viewport,
      chromeSafeArea,
      false,
      true,
    )!;
    expect(projectedEntitiesFitSafeViewport(
      scene,
      visibleIds,
      'context',
      cropped,
      viewport,
      chromeSafeArea,
    )).toBe(false);
  });

  it('Fit architecture to view wires the visible projection and stays a user gesture', () => {
    const fitStart = app.indexOf('aria-label="Fit architecture to view"');
    const fitEnd = app.indexOf('><FitIcon/></button>', fitStart);
    const fit = app.slice(fitStart, fitEnd);
    expect(fit).toContain('frameVisibleProjection(scene, activeProjectionEntityIds, activeDetail, viewport, measureCurrentMapSafeArea())');
    expect(fit).not.toContain('navigationIdentity.rootEntityId');
    expect(fit).not.toContain('false, true');

    const autoFitStart = app.indexOf('const requiresFit = !initialMapFitAppliedRef.current;');
    const autoFitEnd = app.indexOf('}, [detailsOpen, navigationIdentity.rootEntityId, query.fixture, safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);');
    const autoFit = app.slice(autoFitStart, autoFitEnd);
    expect(autoFit).toContain('if (!requiresFit) return;');
    expect(autoFit).toContain('frameProjectionScope(scene, navigationIdentity.rootEntityId, activeDetail, viewport, safeArea, false, true)');
    expect(autoFit).not.toContain('frameVisibleProjection(');
  });
});

function rectsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

describe('CLA-79: Fit after Code rail frames resident L4 cards', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(readFileSync(new URL('../renderer/scanFixture.ts', import.meta.url), 'utf8'))
      .toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(SCAN_RESIDENT_NODES_PER_BAND).toBe(50);
  });

  it('at L4 with explorer code rows, Fit leaves a compiled code card in camera bounds', () => {
    const scene = createC4Scene({
      baseSnapshot: denseNeighborhoodSnapshot('code', 80),
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
    });
    const selected = scene.entities.find(entity => entity.id === 'container:c');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(scene, 'code', ['container:c', 'component:c']);
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, session);
    const codeIds = scene.projection?.entityIdsByDetail.code ?? [];
    expect(codeIds.length).toBeGreaterThan(0);
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(entity => entity.detail === 'code' && codeIds.includes(entity.id))).toBe(true);

    const residentIds = residentVisibleProjectionEntityIds(scene, visibleIds, 'code');
    expect(residentIds.length).toBeGreaterThan(0);
    expect(residentIds.every(id => codeIds.includes(id))).toBe(true);
    expect(residentIds.every(id => scene.entities.find(entity => entity.id === id)?.detail === 'code')).toBe(true);

    const camera = frameVisibleProjection(scene, visibleIds, 'code', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    const world = cameraWorldRect(camera!, viewport);
    const inView = residentIds.filter(id => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.code;
      return bounds ? rectsOverlap(world, bounds) : false;
    });
    expect(inView.length).toBeGreaterThan(0);
  });

  it('Code-rail explorer rows at L4 stay inside the Fit camera on a container neighborhood', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    await fixture.ensureNeighborhood('container:web-app');
    const l4Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'code',
      fixture.navigation.rootEntityId,
    );
    await fixture.ensureNeighborhood(l4Focus);
    const l4 = fixture.createScene(l4Focus);
    const selected = l4.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(l4, 'code', ['container:web-app']);
    const visibleIds = semanticLensSessionVisibleEntityIds(l4, session);
    const rows = explorerEntitiesForView(l4, {
      detail: 'code',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds,
    });
    expect(rows.some(entity => entity.detail === 'code')).toBe(true);
    const camera = frameVisibleProjection(l4, visibleIds, 'code', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    const world = cameraWorldRect(camera!, viewport);
    const codeRows = rows.filter(entity => entity.detail === 'code');
    expect(codeRows.some(entity => {
      const bounds = l4.projection?.boundsByEntityIdAndDetail[entity.id]?.code;
      return bounds ? rectsOverlap(world, bounds) : false;
    })).toBe(true);
  });
});
