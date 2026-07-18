import { describe, expect, it } from 'vitest';
import { COVERAGE_REVEAL } from '@okie/scene-compiler';
import type { ArchitectureSnapshot } from '@okie/architecture';
import { createC4Scene } from '../renderer/goldenC4Scene';
import { frameProjectionScope } from './semanticLensEngine';

// Coverage-reveal drill/rail landing (tasks #30/#33 Stage A framing). Scan mode lands an
// explicit framing at the focus's children-reveal coverage (~70%) so children are visible on
// arrival, instead of clamping up to the band floor (which overframes a large scope). Demo
// (no targetAspect) keeps the band-floor landing → byte-identical, bandPolicy.qa unchanged.

function denseContainerSnapshot(componentCount: number): ArchitectureSnapshot {
  const entities: ArchitectureSnapshot['entities'] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
  ];
  for (let index = 0; index < componentCount; index += 1) {
    const cid = `component:m${String(index).padStart(3, '0')}`;
    entities.push({ id: cid, kind: 'component', parentId: 'container:c', name: `m${index}`, sourceRefs: [] });
    entities.push({ id: `code:${cid}`, kind: 'code', parentId: cid, name: 'k', sourceRefs: [] });
  }
  return { schemaVersion: 1, id: 'snapshot:d', repositoryId: 'repo:d', commitSha: 'c', generatedAt: '2026-01-01T00:00:00.000Z', entities, relations: [] };
}

const scanScene = (componentCount: number, targetAspect?: number) => createC4Scene({
  baseSnapshot: denseContainerSnapshot(componentCount),
  rootEntityId: 'system:d',
  focusEntityId: 'container:c',
  familyId: 'f',
  sceneId: 'scan:d:c4',
  title: 'D',
  subtitle: '',
  frozenRevision: 'c',
  ...(targetAspect !== undefined ? { targetAspect } : {}),
});

const viewport = { width: 1280, height: 720 };
const safeArea = { top: 80, right: 300, bottom: 72, left: 64 };
const COMPONENT_BAND_FLOOR = 3.35;

describe('coverage-reveal drill/rail landing (scan mode)', () => {
  it('lands a large-container drill so the focus covers ~coverageFull, below the band-floor overframe', () => {
    const scene = scanScene(40, 1.6);
    expect(scene.targetAspect).toBe(1.6);
    const camera = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea)!;
    const box = scene.projection!.boundsByEntityIdAndDetail['container:c']!.component!;
    const safeWidth = viewport.width - safeArea.left - safeArea.right;
    const safeHeight = viewport.height - safeArea.top - safeArea.bottom;
    const coverage = Math.max(box.width / safeWidth, box.height / safeHeight) * camera.zoom;
    expect(coverage).toBeGreaterThan(COVERAGE_REVEAL.start); // children are revealed on arrival
    expect(coverage).toBeLessThanOrEqual(1 + 1e-6); // and the focus is not overflowing the viewport
    expect(camera.zoom).toBeLessThan(COMPONENT_BAND_FLOOR); // not the band-floor overframe
  });

  it('rail framing (preferReadableRoot) also lands at the reveal coverage in scan mode', () => {
    const scene = scanScene(40, 1.6);
    const drill = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea, false, false)!;
    const rail = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea, false, true)!;
    // Rail must not snap up to the component focus preset (5.27) when coverage reveal is active.
    expect(rail.zoom).toBeLessThan(COMPONENT_BAND_FLOOR);
    expect(rail.zoom).toBeCloseTo(drill.zoom, 5);
  });

  it('demo (no targetAspect) keeps the band-floor landing — bandPolicy.qa contract preserved', () => {
    const scene = scanScene(40, undefined);
    expect(scene.targetAspect).toBeUndefined();
    const camera = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea)!;
    expect(camera.zoom).toBeGreaterThanOrEqual(COMPONENT_BAND_FLOOR - 1e-9);
  });
});
