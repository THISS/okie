import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { idleSemanticLensSession, semanticLensSessionVisibleEntityIds } from './semanticLens';
import {
  frameProjectionScope,
  frameVisibleProjection,
  projectedEntitiesFitSafeViewport,
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
