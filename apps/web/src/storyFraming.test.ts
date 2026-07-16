import { describe, expect, it } from 'vitest';
import { createCommerceFixture } from './renderer/fixtures';
import { createGoldenC4Scene } from './renderer/goldenC4Scene';
import { classifyStoryOverlayEdge, frameEntities, frameSemanticEntities, measuredStorySafeArea, readableRootCamera, storySafeArea, worldToScreen } from './storyFraming';

describe('frameEntities', () => {
  it('fits every first-step target inside the mobile story safe area', () => {
    const scene = createCommerceFixture(42);
    const viewport = { width: 390, height: 784 };
    const safe = storySafeArea(viewport);
    const ids = ['customer', 'storefront', 'gateway'];
    const camera = frameEntities(scene, ids, viewport, safe);
    expect(camera).toBeDefined();
    if (!camera) return;

    for (const entity of scene.entities.filter(candidate => ids.includes(candidate.id))) {
      const topLeft = worldToScreen(entity.x, entity.y, camera, viewport);
      const bottomRight = worldToScreen(entity.x + entity.width, entity.y + entity.height, camera, viewport);
      expect(topLeft.x).toBeGreaterThanOrEqual(safe.left);
      expect(topLeft.y).toBeGreaterThanOrEqual(safe.top);
      expect(bottomRight.x).toBeLessThanOrEqual(viewport.width - safe.right);
      expect(bottomRight.y).toBeLessThanOrEqual(viewport.height - safe.bottom);
    }
  });

  it('returns undefined when no semantic targets exist', () => {
    expect(frameEntities(createCommerceFixture(42), ['missing'], { width: 390, height: 784 })).toBeUndefined();
  });

  it('uses the authored readable scale and safe center when a whole-scope fit is too small', () => {
    const viewport = { width: 1_280, height: 652 };
    const safeArea = { top: 80, right: 120, bottom: 72, left: 80 };
    const root = { x: 820, y: 120, width: 480, height: 250 };
    const camera = readableRootCamera({ x: 1_080, y: 375, zoom: .18 }, root, .42, viewport, safeArea);
    expect(camera.zoom).toBe(.42);
    const rootCenter = worldToScreen(root.x + root.width / 2, root.y + root.height / 2, camera, viewport);
    expect(rootCenter).toEqual({
      x: safeArea.left + (viewport.width - safeArea.left - safeArea.right) / 2,
      y: safeArea.top + (viewport.height - safeArea.top - safeArea.bottom) / 2,
    });
    expect(readableRootCamera({ x: 10, y: 20, zoom: .6 }, root, .42, viewport, safeArea))
      .toEqual({ x: 10, y: 20, zoom: .6 });
  });
});

describe('frameSemanticEntities', () => {
  it.each([
    {
      name: '2048×1024 QA map',
      viewport: { width: 1_672, height: 918 },
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedZoom: 32,
      expectedCoverage: { width: .71871, height: .88894 },
    },
    {
      name: '1136×768 cropped map',
      viewport: { width: 1_136, height: 768 },
      safeArea: { top: 80, right: 120, bottom: 72, left: 80 },
      expectedZoom: 20.86157,
      expectedCoverage: { width: .83697, height: .86364 },
    },
  ])('uses authored L4 owner bounds and fills the $name safe viewport', ({ viewport, safeArea, expectedZoom, expectedCoverage }) => {
    const scene = createGoldenC4Scene();
    const ownerId = 'component:renderer-gpu';
    const bounds = scene.projection!.boundsByEntityIdAndDetail[ownerId]!.code!;
    const storyCamera = frameSemanticEntities(scene, [ownerId], 'code', viewport, safeArea);
    const ownerCamera = frameSemanticEntities(scene, [ownerId], 'code', viewport, safeArea, { allowFocusRunway: true });

    expect(storyCamera?.zoom).toBe(scene.projection!.zoomPolicy!.bands[3]!.focusZoom);
    expect(ownerCamera?.zoom).toBeCloseTo(expectedZoom, 5);
    if (!ownerCamera) return;
    const safeWidth = viewport.width - safeArea.left - safeArea.right;
    const safeHeight = viewport.height - safeArea.top - safeArea.bottom;
    const coverage = {
      width: bounds.width * ownerCamera.zoom / safeWidth,
      height: bounds.height * ownerCamera.zoom / safeHeight,
    };
    expect(coverage.width).toBeCloseTo(expectedCoverage.width, 5);
    expect(coverage.height).toBeCloseTo(expectedCoverage.height, 5);
    expect(Math.max(coverage.width, coverage.height)).toBeGreaterThanOrEqual(.75);
    expect(Math.max(coverage.width, coverage.height)).toBeLessThanOrEqual(.90);
    const center = worldToScreen(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, ownerCamera, viewport);
    expect(center.x).toBeCloseTo(safeArea.left + safeWidth / 2);
    expect(center.y).toBeCloseTo(safeArea.top + safeHeight / 2);
  });
});

describe('measured story safe area', () => {
  it('subtracts live overlay, visual viewport, and safe-inset geometry', () => {
    const safe = measuredStorySafeArea({ width: 400, height: 700 }, {
      canvas: { top: 60, right: 400, bottom: 700, left: 0 },
      topOverlays: [{ top: 60, right: 400, bottom: 112, left: 0 }],
      leftOverlays: [{ top: 300, right: 52, bottom: 620, left: 8 }],
      bottomOverlays: [{ top: 510, right: 390, bottom: 690, left: 12 }],
      visualViewport: { offsetTop: 72, offsetLeft: 0, width: 390, height: 610 },
      safeInsets: { bottom: 20 },
    });
    expect(safe).toEqual({ top: 76, right: 10, bottom: 214, left: 76 });
  });

  it('classifies a bottom status correctly and preserves a usable desktop story viewport', () => {
    const viewport = { width: 1_280, height: 652 };
    const canvas = { top: 68, right: 1_280, bottom: 720, left: 0 };
    const status = { top: 660, right: 200, bottom: 700, left: 18 };
    expect(classifyStoryOverlayEdge(status, canvas)).toBe('bottom');
    const safe = measuredStorySafeArea(viewport, {
      canvas,
      overlays: [
        { rect: { top: 0, right: 1_280, bottom: 68, left: 0 }, edge: 'top' },
        { rect: status },
        { rect: { top: 451, right: 910, bottom: 662, left: 370 }, edge: 'bottom' },
        { rect: { top: 666, right: 1_262, bottom: 700, left: 1_170 }, edge: 'bottom' },
        { rect: { top: 262, right: 62, bottom: 526, left: 18 }, edge: 'left' },
      ],
    });
    expect(safe).toEqual({ top: 0, right: 0, bottom: 311, left: 104 });
    expect(safe.top + safe.bottom).toBeLessThanOrEqual(viewport.height - 80);
    expect(safe.left + safe.right).toBeLessThanOrEqual(viewport.width - 80);
    const fitted = frameEntities(createCommerceFixture(42), ['customer', 'storefront', 'gateway'], viewport, safe);
    expect(fitted?.zoom).toBeGreaterThan(0.32);
  });

  it('uses the visible launcher or taller Ask popover as the map bottom edge', () => {
    const viewport = { width: 1_280, height: 652 };
    const canvas = { top: 68, right: 1_280, bottom: 720, left: 0 };
    const launcher = { top: 607, right: 930, bottom: 658, left: 350 };
    const askPopover = { top: 330, right: 930, bottom: 598, left: 350 };
    expect(measuredStorySafeArea(viewport, {
      canvas,
      overlays: [{ rect: launcher, edge: 'bottom' }],
      overlayMargin: 0,
    }).bottom).toBe(113);
    expect(measuredStorySafeArea(viewport, {
      canvas,
      overlays: [
        { rect: launcher, edge: 'bottom' },
        { rect: askPopover, edge: 'bottom' },
      ],
      overlayMargin: 0,
    }).bottom).toBe(390);
  });
});
