import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Minimap, minimapEntityRects, minimapProjector, projectedViewportRect, unionRect, worldViewportRect } from './minimap';
import { publishLiveCamera, subscribeLiveCamera } from './liveCameraBridge';
import type { AtlasScene, Camera } from './renderer/types';

describe('worldViewportRect', () => {
  it('centres the visible world rectangle on the camera and scales by 1/zoom', () => {
    const camera: Camera = { x: 100, y: 50, zoom: 2 };
    expect(worldViewportRect(camera, { width: 800, height: 400 })).toEqual({ x: -100, y: -50, width: 400, height: 200 });
  });

  it('grows the visible rect as the camera zooms out', () => {
    expect(worldViewportRect({ x: 0, y: 0, zoom: 0.5 }, { width: 800, height: 600 }))
      .toEqual({ x: -800, y: -600, width: 1600, height: 1200 });
  });
});

describe('minimapEntityRects', () => {
  it('keeps only context (L1) and container (L2) entities', () => {
    const scene = { entities: [
      { id: 'a', detail: 'context', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', detail: 'container', x: 5, y: 5, width: 4, height: 4 },
      { id: 'c', detail: 'component', x: 0, y: 0, width: 1, height: 1 },
      { id: 'd', x: 0, y: 0, width: 1, height: 1 },
    ] } as unknown as AtlasScene;
    expect(minimapEntityRects(scene).map(entry => entry.detail)).toEqual(['context', 'container']);
  });
});

describe('unionRect + minimapProjector', () => {
  it('unions rects and projects world coordinates into the inset, centred', () => {
    const world = unionRect([{ x: 0, y: 0, width: 100, height: 50 }, { x: 100, y: 50, width: 100, height: 50 }]);
    expect(world).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    const project = minimapProjector(world!, 200, 100);
    expect(project({ x: 0, y: 0, width: 200, height: 100 })).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(project({ x: 100, y: 50, width: 0, height: 0 })).toEqual({ x: 100, y: 50, width: 0, height: 0 });
  });

  it('returns undefined for an empty rect set', () => {
    expect(unionRect([])).toBeUndefined();
  });
});

describe('Minimap component', () => {
  it('renders world, L1/L2 entity, and viewport rects as a non-interactive SVG inset', () => {
    const scene = { entities: [
      { id: 'a', detail: 'context', x: 0, y: 0, width: 200, height: 100 },
      { id: 'b', detail: 'container', x: 40, y: 20, width: 60, height: 40 },
    ] } as unknown as AtlasScene;
    const html = renderToStaticMarkup(<Minimap camera={{ x: 100, y: 50, zoom: 1 }} scene={scene} viewport={{ width: 100, height: 60 }}/>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="minimap"');
    expect(html).toContain('minimap-entity detail-context');
    expect(html).toContain('minimap-entity detail-container');
    expect(html).toContain('minimap-viewport');
    expect(html).not.toContain('onClick');
  });

  it('renders nothing when there are no L1/L2 entities to bound', () => {
    const scene = { entities: [{ id: 'c', detail: 'component', x: 0, y: 0, width: 1, height: 1 }] } as unknown as AtlasScene;
    expect(renderToStaticMarkup(<Minimap camera={{ x: 0, y: 0, zoom: 1 }} scene={scene} viewport={{ width: 100, height: 100 }}/>)).toBe('');
  });
});

describe('projectedViewportRect (live-update seam)', () => {
  const world = { x: 0, y: 0, width: 400, height: 200 };
  const project = minimapProjector(world, 160, 80);
  const viewport = { width: 400, height: 200 };

  it('tracks mid-gesture cameras — the rect shrinks toward centre as the camera zooms in', () => {
    const wide = projectedViewportRect({ x: 200, y: 100, zoom: 1 }, viewport, project);
    expect(wide).toEqual({ x: 0, y: 0, width: 160, height: 80 });

    const zoomed = projectedViewportRect({ x: 200, y: 100, zoom: 2 }, viewport, project);
    expect(zoomed.width).toBeCloseTo(80);
    expect(zoomed.height).toBeCloseTo(40);
    expect(zoomed.x).toBeCloseTo(40);
    expect(zoomed.y).toBeCloseTo(20);

    // A distinct pan sample yields a distinct rect — proves it reflects the live camera, not a snapshot.
    const panned = projectedViewportRect({ x: 300, y: 100, zoom: 2 }, viewport, project);
    expect(panned.x).toBeGreaterThan(zoomed.x);
  });

  it('floors the rect to a visible minimum when the camera is extremely zoomed in', () => {
    const tiny = projectedViewportRect({ x: 200, y: 100, zoom: 100000 }, viewport, project);
    expect(tiny.width).toBe(2);
    expect(tiny.height).toBe(2);
  });
});

describe('liveCameraBridge', () => {
  it('delivers published cameras to subscribers and stops after unsubscribe', () => {
    const seen: Camera[] = [];
    const unsubscribe = subscribeLiveCamera(camera => seen.push(camera));
    publishLiveCamera({ x: 1, y: 2, zoom: 3 });
    publishLiveCamera({ x: 4, y: 5, zoom: 6 });
    unsubscribe();
    publishLiveCamera({ x: 7, y: 8, zoom: 9 });
    expect(seen).toEqual([{ x: 1, y: 2, zoom: 3 }, { x: 4, y: 5, zoom: 6 }]);
  });

  it('fans out each published frame to every active subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeLiveCamera(a);
    const unsubB = subscribeLiveCamera(b);
    publishLiveCamera({ x: 0, y: 0, zoom: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });
});
