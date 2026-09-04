import { describe, expect, it, vi } from 'vitest';
import { Canvas2DRenderer, canvasEntityPresentationMetrics } from './Canvas2DRenderer';
import type { AtlasScene, RenderState, SemanticDetail } from './types';

type TextCall = {
  content: string;
  font: string;
  x: number;
  y: number;
  maxWidth?: number;
};

function fakeCanvas() {
  const values: Record<PropertyKey, unknown> = {};
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const textCalls: TextCall[] = [];
  const context = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      const call = calls.get(property) ?? (property === 'fillText'
        ? vi.fn((content: string, x: number, y: number, maxWidth: number) => textCalls.push({
            content,
            font: String(target.font),
            x,
            y,
            maxWidth,
          }))
        : vi.fn());
      calls.set(property, call);
      return call;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    canvas: { width: 0, height: 0, style: {}, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement,
    call: (name: PropertyKey) => calls.get(name) ?? vi.fn(),
    textCalls,
  };
}

const state: RenderState = {
  focusedIds: new Set(),
  activeRelationIds: new Set(),
  flowRelationIds: new Set(),
  reduceMotion: true,
  animate: false,
  visibilityMode: 'all',
};

describe('Canvas2D band-normalized typography', () => {
  it.each([
    { detail: 'context' as const, zoom: 0.75, title: 20, kicker: 13.5, description: 15.5 },
    { detail: 'container' as const, zoom: 1.99, title: 15.5, kicker: 10, description: 11 },
    { detail: 'component' as const, zoom: 5.27, title: 16.5, kicker: 10, description: 11 },
    { detail: 'code' as const, zoom: 13.96, title: 11.2, kicker: 7.2, description: 7.4 },
  ])('keeps $detail focus labels at native presentation scale', ({ detail, zoom, title, kicker, description }) => {
    const metrics = canvasEntityPresentationMetrics(detail, false, zoom);
    expect(metrics.titleFontSize).toBeCloseTo(title, 5);
    expect(metrics.kickerFontSize).toBeCloseTo(kicker, 5);
    expect(metrics.descriptionFontSize).toBeCloseTo(description, 5);
    expect(metrics.titleFontSize).toBeLessThan(30);
  });

  it('preserves the compiler boundary-title treatment at every band', () => {
    const bands: Array<{ detail: SemanticDetail; zoom: number; title: number }> = [
      { detail: 'context', zoom: 0.75, title: 15.6 },
      { detail: 'container', zoom: 1.99, title: 12.09 },
      { detail: 'component', zoom: 5.27, title: 16.5 },
      { detail: 'code', zoom: 13.96, title: 11.2 },
    ];
    for (const { detail, zoom, title } of bands) {
      expect(canvasEntityPresentationMetrics(detail, true, zoom).titleFontSize).toBeCloseTo(title, 5);
    }
  });

  it('keeps L4 text within the authored comfort cap at maximum runway', () => {
    const metrics = canvasEntityPresentationMetrics('code', false, 32);
    expect(metrics.titleFontSize).toBeGreaterThanOrEqual(24);
    expect(metrics.titleFontSize).toBeLessThanOrEqual(26);
    expect(metrics.kickerFontSize).toBeGreaterThanOrEqual(15);
    expect(metrics.kickerFontSize).toBeLessThanOrEqual(17);
    expect(metrics.descriptionFontSize).toBeGreaterThanOrEqual(15);
    expect(metrics.descriptionFontSize).toBeLessThanOrEqual(17);
  });

  it('keeps native Canvas corner and stroke geometry aligned at maximum runway', () => {
    const scene: AtlasScene = {
      id: 'rounded-rect-parity-fixture',
      title: 'Rounded rectangle parity fixture',
      subtitle: '',
      entities: [
        {
          id: 'code:owner',
          name: 'Owner',
          kind: 'component',
          detail: 'code',
          responsibility: 'Owns the fixture.',
          x: 0,
          y: 0,
          width: 20,
          height: 14,
        },
        {
          id: 'code:child',
          parentId: 'code:owner',
          name: 'Child',
          kind: 'component',
          detail: 'code',
          responsibility: 'Exercises card geometry.',
          x: 2,
          y: 2,
          width: 8,
          height: 6,
        },
      ],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(800, 600, 1);
    renderer.setCamera({ x: 10, y: 7, zoom: 32 });
    renderer.setRenderState(state);
    renderer.render(0);

    const ownerMetrics = canvasEntityPresentationMetrics('code', true, 32);
    const childMetrics = canvasEntityPresentationMetrics('code', false, 32);
    const radii = target.call('roundRect').mock.calls.map(call => call[4] as number);
    expect(radii).toContainEqual(ownerMetrics.radius);
    expect(radii).toContainEqual(childMetrics.radius);
    expect(ownerMetrics.radius).toBeCloseTo(57.3066, 3);
    expect(childMetrics.radius).toBeCloseTo(20.0573, 3);
    expect(ownerMetrics.strokeWidth).toBeCloseTo(4.298, 3);
    expect(childMetrics.strokeWidth).toBeCloseTo(5.731, 3);
  });

  it('clips Canvas labels to their card and uses the source path for code descriptions', () => {
    const scene: AtlasScene = {
      id: 'typography-fixture',
      title: 'Typography fixture',
      subtitle: '',
      entities: [{
        id: 'code:validation',
        name: 'validateSnapshotWithLongSuffix',
        kind: 'component',
        kindLabel: 'SOURCE',
        detail: 'code',
        responsibility: 'This prose must not replace the source path at L4.',
        source: 'packages/architecture/src/validation.ts',
        x: 0,
        y: 0,
        width: 30,
        height: 20,
      }],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(600, 400, 1);
    renderer.setCamera({ x: 15, y: 10, zoom: 13.96 });
    renderer.setRenderState(state);
    renderer.render(0);

    const card = { x: 90.6, y: 60.4, width: 418.8, height: 279.2 };
    const [clipRect] = target.call('rect').mock.calls.at(-1)!;
    expect(clipRect).toBeCloseTo(card.x);
    expect(target.call('rect').mock.calls.at(-1)![1]).toBeCloseTo(card.y);
    expect(target.call('rect').mock.calls.at(-1)![2]).toBeCloseTo(card.width);
    expect(target.call('rect').mock.calls.at(-1)![3]).toBeCloseTo(card.height);
    expect(target.call('clip')).toHaveBeenCalled();
    expect(target.textCalls).toHaveLength(3);
    expect(target.textCalls[1]!.font).toContain('11.2px');
    expect(target.textCalls[2]!.content).toContain('validation.ts');
    expect(target.textCalls[2]!.content).not.toContain('prose');
    for (const call of target.textCalls) {
      expect(call.x).toBeGreaterThanOrEqual(card.x);
      expect(call.x).toBeLessThanOrEqual(card.x + card.width);
      expect(call.y).toBeGreaterThanOrEqual(card.y);
      expect(call.y).toBeLessThanOrEqual(card.y + card.height);
    }
  });

  it('keeps L1/L2 titles at the 12px floor and preserves scoped package tails at context zoom', () => {
    const metrics = canvasEntityPresentationMetrics('context', false, 0.32);
    expect(metrics.titleFontSize).toBeGreaterThanOrEqual(12);
    expect(metrics.titleFontSize).toBe(12);

    const scene: AtlasScene = {
      id: 'cla-53-labels',
      title: 'CLA-53 labels',
      subtitle: '',
      entities: [
        {
          id: 'external:react',
          name: 'react',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: 'No summary supplied.',
          x: 0,
          y: 0,
          width: 480,
          height: 190,
        },
        {
          id: 'external:fontsource',
          name: '@fontsource/ibm-plex-sans',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: 'No summary supplied.',
          x: 520,
          y: 0,
          width: 480,
          height: 190,
        },
        {
          id: 'external:dompurify',
          name: 'dompurify',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: 'No summary supplied.',
          x: 1040,
          y: 0,
          width: 480,
          height: 190,
        },
      ],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1200, 400, 1);
    renderer.setCamera({ x: 760, y: 95, zoom: 0.32 });
    renderer.setRenderState(state);
    renderer.render(0);

    const titles = target.textCalls.filter(call => call.font.includes('12px'));
    const names = titles.map(call => call.content);
    expect(names).toContain('react');
    expect(names).toContain('dompurify');
    const fontsource = names.find(name => name.includes('ibm-plex-sans') || name.includes('fontsource'));
    expect(fontsource).toBeDefined();
    expect(fontsource).toMatch(/ibm-plex-sans$/);
    expect(fontsource?.startsWith('@fontsource/ibm-') && !fontsource.includes('plex-sans')).toBe(false);
    expect(target.textCalls.some(call => call.content === 'No summary supplied.')).toBe(true);
  });

  it('paints the honest placeholder when Canvas2D entities have no summary (CLA-58)', () => {
    const scene: AtlasScene = {
      id: 'cla-58-canvas',
      title: 'CLA-58 canvas',
      subtitle: '',
      entities: [
        {
          id: 'external:react',
          name: 'react',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: '',
          x: 0,
          y: 0,
          width: 480,
          height: 190,
        },
        {
          id: 'system:okie',
          name: 'okie',
          kind: 'system',
          kindLabel: 'SOFTWARE SYSTEM',
          detail: 'context',
          responsibility: 'Spatial architecture atlas.',
          x: 520,
          y: 0,
          width: 480,
          height: 190,
        },
      ],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1200, 400, 1);
    renderer.setCamera({ x: 500, y: 95, zoom: 0.75 });
    renderer.setRenderState(state);
    renderer.render(0);

    expect(target.textCalls.some(call => call.content === 'No summary supplied.')).toBe(true);
    expect(target.textCalls.some(call => call.content === 'Spatial architecture atlas.')).toBe(true);
  });
  });
});
