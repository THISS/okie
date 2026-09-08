import { C4_LABEL_MIN_TITLE_PX, c4TitleFitFloor, fitDisplayTextAtSize, NO_SUMMARY_SUPPLIED } from '@okie/scene-compiler';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasHoverHud, canvasHoverHudModel, cardNeedsHoverHud, samePickResult } from './canvasHoverHud';
import { canvasEntityPresentationMetrics } from './renderer/Canvas2DRenderer';
import type { AtlasScene, Camera, SceneEntity, SemanticDetail } from './renderer/types';

const viewport = { width: 800, height: 400 };
const cameraAt = (zoom: number): Camera => ({ x: 40, y: 12, zoom });

function entity(overrides: Partial<SceneEntity> & Pick<SceneEntity, 'id' | 'name'>): SceneEntity {
  return {
    kind: 'component',
    responsibility: 'Owns the hover HUD fixture.',
    x: 0,
    y: 0,
    width: 80,
    height: 24,
    ...overrides,
  };
}

function sceneFor(target: SceneEntity, extras: { children?: SceneEntity[]; visibleIds?: string[] } = {}): AtlasScene {
  const entities = [target, ...(extras.children ?? [])];
  const visibleIds = extras.visibleIds ?? entities.map(entity => entity.id);
  const emptyIds = { context: [], container: [], component: [], code: [] } as const;
  return {
    id: 'cla-113-hover-hud',
    title: 'CLA-113 hover HUD',
    subtitle: '',
    entities,
    relations: [],
    regions: [],
    projection: {
      semanticToVisualEntityId: {},
      visualToSemanticEntityId: {},
      semanticToVisualRelationIds: {},
      visualToSemanticRelationIds: {},
      boundsByEntityIdAndDetail: {},
      entityIdsByDetail: { ...emptyIds, [target.detail ?? 'component']: visibleIds },
      relationIdsByDetail: { ...emptyIds },
      projectedRelationsByDetail: { ...emptyIds },
    },
  };
}

function query(
  target: SceneEntity,
  detail: SemanticDetail,
  zoom: number,
  extra: { suppress?: boolean; children?: SceneEntity[]; visibleIds?: string[] } = {},
) {
  return {
    pick: { kind: 'entity' as const, id: target.id },
    scene: sceneFor(target, extra),
    camera: cameraAt(zoom),
    viewport,
    detail,
    ...(extra.suppress ? { suppress: true } : {}),
  };
}

describe('canvas hover HUD (CLA-113)', () => {
  it('shows the full filename when a narrow L3 title truncates', () => {
    const zoom = 5.27;
    const metrics = canvasEntityPresentationMetrics('component', false, zoom);
    const floor = c4TitleFitFloor('component', metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX);
    const name = 'src/diagnostics.rs';
    const fitted = fitDisplayTextAtSize(name, 52, metrics.titleFontSize, floor, 'identifier', 'sans-semibold');
    expect(fitted.content).toBe('di…cs.rs');

    const target = entity({
      id: 'component:diagnostics',
      name,
      kindLabel: 'COMPONENT',
      detail: 'component',
      source: 'crates/atlas-engine/src/diagnostics.rs',
      width: (52 + metrics.horizontalInsets) / zoom,
    });
    expect(cardNeedsHoverHud(target, 'component', false, zoom, 52)).toBe(true);
    const model = canvasHoverHudModel(query(target, 'component', zoom));
    expect(model?.name).toBe(name);
    expect(model?.path).toBe('crates/atlas-engine/src/diagnostics.rs');
    expect(model?.detail).toBe('Owns the hover HUD fixture.');
  });

  it('shows a HUD for the empty-summary placeholder and omits that copy from the chip', () => {
    const zoom = 1.99;
    const target = entity({
      id: 'container:web',
      name: '@okie/web',
      kind: 'container',
      kindLabel: 'CONTAINER',
      detail: 'container',
      responsibility: NO_SUMMARY_SUPPLIED,
      source: 'apps/web',
      width: 220,
    });
    const model = canvasHoverHudModel(query(target, 'container', zoom));
    expect(model?.name).toBe('@okie/web');
    expect(model?.path).toBe('apps/web');
    expect(model?.detail).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain(NO_SUMMARY_SUPPLIED);
  });

  it('treats an L2/L3 parent as a filled card when children are only in a deeper band', () => {
    const zoom = 1.99;
    const parent = entity({
      id: 'container:web',
      name: '@okie/web',
      kind: 'container',
      kindLabel: 'CONTAINER',
      detail: 'container',
      responsibility: NO_SUMMARY_SUPPLIED,
      source: 'apps/web',
      width: 220,
    });
    const child = entity({
      id: 'component:shell',
      parentId: parent.id,
      name: 'Application shell',
      detail: 'component',
      width: 40,
    });
    const deeperOnly = canvasHoverHudModel(query(parent, 'container', zoom, {
      children: [child],
      visibleIds: [parent.id],
    }));
    expect(deeperOnly?.name).toBe('@okie/web');
    expect(deeperOnly?.path).toBe('apps/web');
    expect(JSON.stringify(deeperOnly)).not.toContain(NO_SUMMARY_SUPPLIED);

    const paintedShell = canvasHoverHudModel(query(parent, 'container', zoom, {
      children: [child],
      visibleIds: [parent.id, child.id],
    }));
    expect(paintedShell).toBeUndefined();
  });

  it('stays quiet on a fully visible card with a real summary', () => {
    const zoom = 0.75;
    const target = entity({
      id: 'system:okie',
      name: 'okie',
      kind: 'system',
      kindLabel: 'SOFTWARE SYSTEM',
      detail: 'context',
      responsibility: 'Spatial architecture atlas.',
      width: 400,
      height: 160,
    });
    expect(cardNeedsHoverHud(target, 'context', false, zoom, 400 * zoom)).toBe(false);
    expect(canvasHoverHudModel(query(target, 'context', zoom))).toBeUndefined();
  });

  it('prefers a code signature over the empty placeholder', () => {
    const zoom = 13.96;
    const metrics = canvasEntityPresentationMetrics('code', false, zoom);
    const name = 'createNavigationHistoryController()';
    const worldWidth = 8;
    const screenWidth = worldWidth * zoom;
    const textMaxWidth = Math.max(1, screenWidth - metrics.horizontalInsets);
    const floor = c4TitleFitFloor('code', metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX);
    const fitted = fitDisplayTextAtSize(name, textMaxWidth, metrics.titleFontSize, floor, 'identifier', 'mono-semibold');
    expect(fitted.content.includes('…') || fitted.content.length < name.length).toBe(true);

    const target = entity({
      id: 'code:history',
      name,
      kindLabel: 'SOURCE',
      detail: 'code',
      responsibility: NO_SUMMARY_SUPPLIED,
      source: 'apps/web/src/navigation/historyController.ts',
      sourceExcerpts: [{
        path: 'apps/web/src/navigation/historyController.ts',
        symbol: 'createNavigationHistoryController',
        language: 'typescript',
        startLine: 1,
        endLine: 2,
        highlightLine: 1,
        frozenRevision: 'test',
        lines: ['export function createNavigationHistoryController(', '  defaults: NavigationDefaults,'],
        text: 'export function createNavigationHistoryController(\n  defaults: NavigationDefaults,',
      }],
      width: worldWidth,
      height: 12,
    });
    const model = canvasHoverHudModel(query(target, 'code', zoom));
    expect(model?.name).toBe(name);
    expect(model?.path).toBe('apps/web/src/navigation/historyController.ts');
    expect(model?.detail).toBe('export function createNavigationHistoryController(');
    expect(model?.detail).not.toBe(NO_SUMMARY_SUPPLIED);
  });

  it('does not steal connect-tool hover or pan/zoom/select', () => {
    const zoom = 5.27;
    const target = entity({
      id: 'component:diagnostics',
      name: 'src/diagnostics.rs',
      detail: 'component',
      responsibility: NO_SUMMARY_SUPPLIED,
      width: 10,
    });
    expect(canvasHoverHudModel(query(target, 'component', zoom, { suppress: true }))).toBeUndefined();
    expect(canvasHoverHudModel({
      ...query(target, 'component', zoom),
      pick: { kind: 'relation', id: 'relation:x' },
    })).toBeUndefined();
    expect(samePickResult({ kind: 'entity', id: 'a' }, { kind: 'entity', id: 'a' })).toBe(true);
    expect(samePickResult({ kind: 'entity', id: 'a' }, { kind: 'entity', id: 'b' })).toBe(false);
  });

  it('renders a pointer-events-none frosted chip', () => {
    const markup = renderToStaticMarkup(<CanvasHoverHud model={{
      entityId: 'component:diagnostics',
      name: 'src/diagnostics.rs',
      path: 'crates/atlas-engine/src/diagnostics.rs',
      detail: 'CPU diagnostics for the atlas engine.',
      left: 120,
      top: 40,
      place: 'above',
    }}/>);
    expect(markup).toContain('data-testid="canvas-hover-hud"');
    expect(markup).toContain('src/diagnostics.rs');
    expect(markup).toContain('crates/atlas-engine/src/diagnostics.rs');
    expect(markup).toContain('CPU diagnostics for the atlas engine.');
    expect(markup).toContain('role="tooltip"');
    expect(markup).not.toContain(NO_SUMMARY_SUPPLIED);
  });
});
