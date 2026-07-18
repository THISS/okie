import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Minimap,
  minimapEntityRects,
  minimapGrabOffset,
  minimapInsetPoint,
  minimapInverseProjector,
  minimapPanCamera,
  minimapProjector,
  projectedViewportRect,
  unionRect,
  worldViewportRect,
  type MinimapPanPhase,
  type MinimapPoint,
} from './minimap';
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
  const scene = { entities: [
    { id: 'a', detail: 'context', x: 0, y: 0, width: 200, height: 100 },
    { id: 'b', detail: 'container', x: 40, y: 20, width: 60, height: 40 },
  ] } as unknown as AtlasScene;

  it('renders world, L1/L2 entity, and viewport rects as an SVG inset', () => {
    const html = renderToStaticMarkup(<Minimap camera={{ x: 100, y: 50, zoom: 1 }} scene={scene} viewport={{ width: 100, height: 60 }}/>);
    expect(html).toContain('class="minimap"');
    expect(html).toContain('minimap-entity detail-context');
    expect(html).toContain('minimap-entity detail-container');
    expect(html).toContain('minimap-viewport');
  });

  // A11y contract: without onPan the inset is a decorative indicator (aria-hidden); with onPan it is
  // a pointer-only affordance — labelled and role="img", never aria-hidden, and never tab-focusable.
  it('stays decorative (aria-hidden, unlabelled) when no onPan handler is supplied', () => {
    const html = renderToStaticMarkup(<Minimap camera={{ x: 100, y: 50, zoom: 1 }} scene={scene} viewport={{ width: 100, height: 60 }}/>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-label');
    expect(html).not.toContain('role="img"');
  });

  it('becomes a labelled, non-focusable affordance when onPan is supplied', () => {
    const html = renderToStaticMarkup(<Minimap camera={{ x: 100, y: 50, zoom: 1 }} onPan={() => {}} scene={scene} viewport={{ width: 100, height: 60 }}/>);
    expect(html).toContain('aria-label="Map overview — drag to pan"');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('aria-hidden');
    expect(html).not.toContain('tabindex');
  });

  it('renders nothing when there are no L1/L2 entities to bound', () => {
    const bare = { entities: [{ id: 'c', detail: 'component', x: 0, y: 0, width: 1, height: 1 }] } as unknown as AtlasScene;
    expect(renderToStaticMarkup(<Minimap camera={{ x: 0, y: 0, zoom: 1 }} onPan={() => {}} scene={bare} viewport={{ width: 100, height: 100 }}/>)).toBe('');
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

describe('minimapInverseProjector', () => {
  it('is the exact inverse of minimapProjector for arbitrary world points', () => {
    const world = { x: -40, y: 15, width: 300, height: 120 };   // world aspect ≠ inset aspect → centring offset
    const project = minimapProjector(world, 160, 80);
    const inverse = minimapInverseProjector(world, 160, 80);
    for (const p of [{ x: -40, y: 15 }, { x: 110, y: 75 }, { x: 260, y: 135 }, { x: 33.5, y: 101.2 }]) {
      const projected = project({ x: p.x, y: p.y, width: 0, height: 0 });
      const back = inverse({ x: projected.x, y: projected.y });
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
  });
});

describe('minimapInsetPoint', () => {
  it('maps client coordinates into inset coordinates relative to the box', () => {
    expect(minimapInsetPoint({ x: 130, y: 220 }, { left: 100, top: 200, width: 160, height: 80 }, 160, 80)).toEqual({ x: 30, y: 20 });
  });

  it('corrects for CSS scaling between the DOM box and the viewBox', () => {
    // DOM box rendered at 320×160 but the viewBox is 160×80 → half-scale on both axes.
    expect(minimapInsetPoint({ x: 100, y: 200 }, { left: 0, top: 0, width: 320, height: 160 }, 160, 80)).toEqual({ x: 50, y: 100 });
  });

  it('returns undefined for a degenerate (zero-area) box', () => {
    expect(minimapInsetPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, 160, 80)).toBeUndefined();
  });
});

describe('minimapGrabOffset + minimapPanCamera (drag/click math)', () => {
  const world = { x: 0, y: 0, width: 400, height: 200 };
  const project = minimapProjector(world, 200, 100);       // uniform scale 0.5, no centring offset
  const inverse = minimapInverseProjector(world, 200, 100);
  const viewport = { width: 400, height: 200 };
  const camera = { x: 200, y: 100, zoom: 2 };              // box occupies inset [50,150]×[25,75]

  it('click-to-centre (a miss) maps the inset point straight to the camera centre, zoom held', () => {
    const point = { x: 20, y: 10 };                        // outside the viewport box
    const { inside, offset } = minimapGrabOffset(point, camera, viewport, project);
    expect(inside).toBe(false);
    expect(offset).toEqual({ x: 0, y: 0 });
    expect(minimapPanCamera(inverse, point, offset, camera.zoom)).toEqual({ x: 40, y: 20, zoom: 2 });
  });

  it('grabbing the box keeps it anchored under the cursor (offset preserved, no jump)', () => {
    const down = { x: 104, y: 52 };                        // 4px right / 2px below the box centre (100,50)
    const { inside, offset } = minimapGrabOffset(down, camera, viewport, project);
    expect(inside).toBe(true);
    expect(offset).toEqual({ x: 4, y: 2 });
    // Dragging to (120,50) moves the camera centre by the inset delta / scale — it does not
    // jump the box centre onto the cursor.
    expect(minimapPanCamera(inverse, { x: 120, y: 50 }, offset, camera.zoom)).toEqual({ x: 232, y: 96, zoom: 2 });
  });

  it('preserves whatever zoom the camera held at grab time', () => {
    expect(minimapPanCamera(inverse, { x: 40, y: 40 }, { x: 0, y: 0 }, 7.5).zoom).toBe(7.5);
  });
});

describe('minimap drag/click drives onPan with the right phases and cameras', () => {
  const world = { x: 0, y: 0, width: 400, height: 200 };
  const project = minimapProjector(world, 200, 100);
  const inverse = minimapInverseProjector(world, 200, 100);
  const viewport = { width: 400, height: 200 };
  const camera = { x: 200, y: 100, zoom: 2 };

  // Mirror of the component's pointer→onPan wiring, fed inset-space points (jsdom-free: the test
  // environment has no DOM, so we exercise the exact helper composition the handlers use).
  function drive(down: MinimapPoint, moves: MinimapPoint[]) {
    const calls: { camera: Camera; phase: MinimapPanPhase }[] = [];
    const onPan = (next: Camera, phase: MinimapPanPhase) => calls.push({ camera: next, phase });
    const { inside, offset } = minimapGrabOffset(down, camera, viewport, project);
    onPan(inside ? camera : minimapPanCamera(inverse, down, offset, camera.zoom), 'start');
    for (const move of moves) onPan(minimapPanCamera(inverse, move, offset, camera.zoom), 'move');
    const last = moves[moves.length - 1] ?? down;
    onPan(minimapPanCamera(inverse, last, offset, camera.zoom), 'settle');
    return calls;
  }

  it('dragging the box streams move updates then a final settle, holding zoom throughout', () => {
    const calls = drive({ x: 104, y: 52 }, [{ x: 120, y: 50 }, { x: 140, y: 60 }]);
    expect(calls.map(call => call.phase)).toEqual(['start', 'move', 'move', 'settle']);
    expect(calls[0]!.camera).toEqual(camera);                        // grab holds position on start
    expect(calls[1]!.camera).toEqual({ x: 232, y: 96, zoom: 2 });
    expect(calls[2]!.camera).toEqual({ x: 272, y: 116, zoom: 2 });
    expect(calls.at(-1)!.camera).toEqual({ x: 272, y: 116, zoom: 2 }); // settle reflects the last move
    expect(calls.every(call => call.camera.zoom === 2)).toBe(true);
  });

  it('clicking empty inset centres there on both start and settle', () => {
    const calls = drive({ x: 20, y: 10 }, []);
    expect(calls.map(call => call.phase)).toEqual(['start', 'settle']);
    expect(calls[0]!.camera).toEqual({ x: 40, y: 20, zoom: 2 });
    expect(calls[1]!.camera).toEqual({ x: 40, y: 20, zoom: 2 });
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
