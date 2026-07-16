import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

function pixels(block: string, property: string): number {
  const match = block.match(new RegExp(`${property}:\\s*(\\d+)px`));
  if (!match) throw new Error(`Missing pixel declaration for ${property}`);
  return Number(match[1]);
}

describe('shared map control layout', () => {
  it('reserves the details-toggle lane beside the desktop authoring toolbar', () => {
    const toolbar = declarations(css, '.authoring-toolbar');
    const toggle = declarations(css, '.details-toggle');
    const gap = pixels(toolbar, 'right') - pixels(toggle, 'right') - pixels(toggle, 'width');

    expect(gap).toBeGreaterThanOrEqual(8);
  });

  it('stacks mobile authoring below the details and entity controls', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 780px)'));
    const toolbar = declarations(mobile, '.authoring-toolbar');
    const explorer = declarations(mobile, '.entity-explorer');
    const explorerBottom = pixels(explorer, 'top') + 31;

    expect(pixels(toolbar, 'top') - explorerBottom).toBeGreaterThanOrEqual(8);
  });
});

describe('view and edit interaction modes', () => {
  it('defaults to View and gates every relationship mutation surface behind Edit', () => {
    expect(app).toContain("useState<'view' | 'edit'>('view')");
    expect(app).toContain("const editingEnabled = interactionMode === 'edit' && authoringEnabled");
    expect(app).toContain('authoringEnabled={editingEnabled}');
    expect(app).toContain("{interactionMode === 'edit' && <div aria-label=\"Relationship authoring tools\"");
    expect(app).toContain("{interactionMode === 'edit' && <div aria-label=\"Relationship editing actions\"");
    expect(app).toContain("if (!editingEnabled || !pickedRelationId)");
    expect(app).toContain('data-interaction-mode={interactionMode}');
  });

  it('cancels in-flight connect and route-guide drafts when Edit is left', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);

    expect(viewport).toContain('if (authoringEnabled) return;');
    expect(viewport).toContain('authoringPointerRef.current = undefined;');
    expect(viewport).toContain('updateConnectionDraft(undefined);');
    expect(viewport).toContain('updateGuideDraft(undefined);');
    expect(app).toContain("if (next === 'view') setAuthoringTool('select')");
  });

  it('keeps selected View flow rendering continuously but suspends it during route authoring', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);

    expect(viewport).toContain('pointerInteraction: currentPointerInteraction()');
    expect(viewport).toContain("if (authoringPointerRef.current) return 'authoring-drag'");
    expect(viewport).toContain("return pointerRef.current?.moved ? 'camera-pan' : 'idle'");
    expect(viewport).toContain('animate: animation.animateFlow');
    expect(viewport).toContain('syncContinuousRendering();');
  });

  it('does not route camera pan through the story-interruption callback', () => {
    const panStart = app.indexOf('function handlePointerMove');
    const panEnd = app.indexOf('function handlePointerUp', panStart);
    const panHandler = app.slice(panStart, panEnd);
    const cameraPan = panHandler.slice(panHandler.indexOf('pointer.moved = true'));

    expect(cameraPan).toContain('syncContinuousRendering();');
    expect(cameraPan).not.toContain("onInteractionStartRef.current('Panned the map'");
  });

  it('cancels only the transient inspector flight for direct pan, wheel, and pinch', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);

    expect(app).toContain('onCameraFlightCancel={cancelInspectorCameraFlight}');
    expect(app).toContain('const liveCamera = { ...renderedCameraRef.current };');
    expect(app).toContain('updateCamera(liveCamera);');
    expect(viewport.match(/onCameraFlightCancelRef\.current\(\)/g)).toHaveLength(3);
    expect(viewport).toContain("onInteractionStartRef.current('Pinched the map'");
    expect(viewport).not.toContain("onInteractionStartRef.current('Panned the map'");
  });

  it('presents the mode choice as a polished two-state control', () => {
    expect(app).toContain('data-testid="interaction-mode-view"');
    expect(app).toContain('data-testid="interaction-mode-edit"');
    expect(declarations(css, '.diagram-mode-toggle')).toContain('border-radius: 8px');
    expect(declarations(css, '.diagram-mode-toggle button')).toContain('min-width: 55px');
    expect(css).toContain('.mode-indicator');
    expect(css).toContain('@keyframes authoring-tools-enter');
  });
});

describe('multi-diagram workspace shell', () => {
  it('renders one active panel with a pinned Main tab and closable derived tabs', () => {
    expect(app).toContain('role="tablist"');
    // Main tab shows no kind badge and no visible "Pinned" label (production chrome),
    // but retains its pinned accessible name.
    expect(app).not.toContain('<small>Pinned</small>');
    expect(app).toContain("aria-label={surface.kind === 'main' ? 'Main diagram, pinned'");
    expect(app).toContain("surface.kind !== 'main' && <span aria-hidden=\"true\" className={`diagram-kind-mark");
    expect(app).toContain('surface.closable && <button');
    expect(app).toContain("activeDiagramSurface.kind === 'main' ? <>");
    expect(app.match(/<CanvasViewport/g)).toHaveLength(1);
    expect(app).toContain('<SemanticDiagramSurface');
  });

  it('offers a mobile Views switcher and an inspector path to a dynamic Flow surface', () => {
    expect(app).toContain('className="mobile-diagram-switcher"');
    expect(app).toContain('aria-label="Active diagram view"');
    expect(app).toContain('data-diagram-action="open-flow"');
    expect(app).toContain("openDerivedDiagram('flow')");

    const mobile = css.slice(css.indexOf('@media (max-width: 780px)'));
    expect(declarations(mobile, '.diagram-tabs')).toContain('display: none');
    expect(declarations(mobile, '.mobile-diagram-switcher')).toContain('display: flex');
  });

  it('feeds derived flow and Mermaid surfaces from semantic compiler artifacts with notation readiness', () => {
    expect(app).toContain('compileC4DynamicFlowArtifact');
    expect(app).toContain('serializeDynamicFlowMermaid');
    expect(app).toContain('validateC4NotationCompleteness');
    expect(app).toContain('flowArtifact={activeDynamicFlowArtifact}');
    expect(app).toContain('data-diagram-action="open-mermaid"');
    expect(css).toContain('.notation-readiness');
    expect(css).toContain('.semantic-diagram-readiness');
  });

  it('reserves one compact shell row above the shared workspace panel', () => {
    expect(declarations(css, '.app-shell')).toContain('grid-template-rows: var(--topbar-height) var(--diagram-tabs-height) minmax(0, 1fr)');
    expect(declarations(css, '.diagram-view-bar')).toContain('border-bottom: 1px solid var(--atlas-line)');
  });
});

describe('compact inspector presentation', () => {
  it('keeps one swappable entity presentation with immediate actions and ordered navigation sections', () => {
    const presentationStart = app.indexOf('data-inspector-presentation="entity"');
    const actions = app.indexOf('aria-label="Entity actions"', presentationStart);
    const children = app.indexOf('<h3>Inside this layer</h3>', presentationStart);
    const relationships = app.indexOf('<h3>Relationships</h3>', presentationStart);
    const sources = app.indexOf('<h3>Source evidence</h3>', presentationStart);

    expect(presentationStart).toBeGreaterThan(0);
    expect(actions).toBeGreaterThan(presentationStart);
    expect(children).toBeGreaterThan(actions);
    expect(relationships).toBeGreaterThan(children);
    expect(sources).toBeGreaterThan(relationships);
    expect(app).toContain('selectedChildren.map(child =>');
    expect(app).toContain('selected.sourceRefs.map((source, index) =>');
  });

  it('publishes stable relation-summary hooks and presents the destination before relation metadata', () => {
    expect(app).toContain('data-inspector-presentation="relation-summary"');
    expect(app).toContain('data-inspector-relation-id={relation.id}');
    expect(app).toContain('<strong>{other.name}</strong><small>{relationshipLabel}');
    expect(app).toContain("onClick={() => inspectRelation(relation, 'panel')}");
  });

  it('swaps selected edges into a dedicated relationship inspector with endpoint and editing actions', () => {
    const presentationStart = app.indexOf('data-inspector-presentation="relation"');
    const endpoints = app.indexOf('<h3>Endpoints</h3>', presentationStart);
    const evidence = app.indexOf('<h3>Evidence context</h3>', presentationStart);
    const editing = app.indexOf('aria-label="Relationship editing actions"', presentationStart);

    expect(presentationStart).toBeGreaterThan(0);
    expect(endpoints).toBeGreaterThan(presentationStart);
    expect(evidence).toBeGreaterThan(endpoints);
    expect(editing).toBeGreaterThan(evidence);
    expect(app).toContain('selectedRelationPresentation(scene, pickedRelation, pickedRelation.from)');
    expect(app).toContain('visibleSemanticRelationsForEntity(scene, activeProjectionRelationIds, selected.id)');
  });

  it('uses a panel-local Back stack only for inspector-originated subject traversal', () => {
    const restoreStart = app.indexOf('function restoreInspectorHistoryNavigation');
    const backStart = app.indexOf('function navigateInspectorBack()');
    const backEnd = app.indexOf('function handlePick', backStart);
    const restoreImplementation = app.slice(restoreStart, backStart);
    const backImplementation = app.slice(backStart, backEnd);

    expect(app).toContain('popInspectorHistory(inspectorHistory)');
    expect(app).toContain('inspectorHistory.length > 0 && <button aria-label="Back to previous inspector selection"');
    expect(app).toContain("focusEntity(pickedRelationPresentation.source, 'replace', 'frame', 'details', 'panel')");
    expect(app).toContain('onClick={() => navigateInspectorHierarchy(selectedParent)}');
    expect(app).toContain('onClick={() => navigateInspectorHierarchy(child)}');
    expect(app).toContain('semanticInspectorHierarchyPlan(');
    expect(app).toContain('detail: plan.session.baseDetail');
    expect(app).toContain('lensPath: semanticLensCanonicalPathIds(plan.session)');
    expect(app).toContain("inspectRelation(relation, 'panel')");
    expect(app).toContain('camera: { ...currentNavigation.camera }');
    expect(restoreImplementation).toContain('inspectorHistoryRestorePlan(navigationRef.current, subject)');
    expect(restoreImplementation).toContain('startInspectorCameraFlight({');
    expect(restoreImplementation).toContain('targetCamera: plan.state.camera');
    expect(restoreImplementation).toContain('historyMode: plan.mode');
    expect(backImplementation).not.toContain('reframeEntityAfterInspectorChange');
    expect(backImplementation).toContain("(restoredTab === 'source' ? sourceTabRef : detailsTabRef).current?.focus");
    expect(backImplementation).not.toContain('window.history.back()');
  });

  it('animates hierarchy navigation without story-flight coupling or per-frame history writes', () => {
    const flightStart = app.indexOf('function startInspectorCameraFlight');
    const flightEnd = app.indexOf('function cancelInspectorCameraFlight', flightStart);
    const implementation = app.slice(flightStart, flightEnd);

    expect(implementation).toContain('semanticInspectorFlightSession(');
    expect(implementation).toContain('semanticInspectorRawCameraTarget(');
    expect(implementation).toContain('compensateSemanticInspectorFlightCamera(');
    expect(implementation).toContain('onComplete: () =>');
    expect(implementation.match(/commitNavigation\(/g)).toHaveLength(1);
    expect(implementation).not.toContain('storyFlightRef');
  });

  it('aborts a hierarchy flight before external navigation can replace its destination', () => {
    const abortStart = app.indexOf('function abortInspectorCameraFlight');
    const abortEnd = app.indexOf('\n  useEffect(() => {', abortStart);
    const abortImplementation = app.slice(abortStart, abortEnd);
    const focusStart = app.indexOf('function focusEntity');
    const focusEnd = app.indexOf('function navigateInspectorHierarchy', focusStart);
    const focusImplementation = app.slice(focusStart, focusEnd);

    expect(abortImplementation).toContain('collapseInspectorFlightSession(semanticLensSessionRef.current)');
    expect(abortImplementation).toContain('inspectorCameraFlightControllerRef.current?.cancel()');
    expect(abortImplementation).toContain('pendingInspectorCameraFlightRef.current = undefined');
    expect(abortImplementation).toContain('updateCamera(liveCamera)');
    expect(abortImplementation).not.toContain('commitNavigation(');
    expect(focusImplementation.indexOf('abortInspectorCameraFlight()'))
      .toBeLessThan(focusImplementation.indexOf('setSelectedId(entity.id)'));
  });

  it('pins the compact desktop type scale and full-width mobile actions', () => {
    expect(declarations(css, '.details-panel')).toContain('grid-template-rows: 44px 34px minmax(0, 1fr)');
    expect(declarations(css, '.details-scroll')).toContain('padding: 22px 22px 36px');
    expect(declarations(css, '.entity-hero h2')).toMatch(/font-size:\s*27px/);
    expect(declarations(css, '.entity-hero h2')).toMatch(/line-height:\s*1\.08/);
    expect(declarations(css, '.detail-actions button')).toMatch(/min-height:\s*35px/);
    expect(declarations(css, '.relation-facts div')).toContain('grid-template-columns: 92px minmax(0, 1fr)');

    const mobile = css.slice(css.indexOf('@media (max-width: 470px)'));
    expect(declarations(mobile, '.details-panel')).toContain('grid-template-rows: 44px 44px minmax(0, 1fr)');
    expect(declarations(mobile, '.inspector-tabs button')).toContain('min-height: 44px');
    expect(declarations(mobile, '.detail-actions')).toContain('grid-template-columns: 1fr');
    expect(declarations(mobile, '.detail-actions button')).toContain('min-height: 44px');
    expect(declarations(mobile, '.details-header button')).toContain('height: 44px');
  });
});

describe('canvas minimap', () => {
  it('renders a non-interactive minimap inset near the zoom controls', () => {
    expect(app).toContain('<Minimap camera={camera} scene={scene} viewport={viewport}/>');
    expect(declarations(css, '.minimap')).toContain('pointer-events: none');
    expect(declarations(css, '.minimap')).toContain('position: absolute');
  });

  it('hides the minimap on very narrow viewports', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 390px)'));
    expect(declarations(narrow, '.minimap')).toContain('display: none');
  });
});

describe('canvas screenshot capture', () => {
  it('exposes a screenshot control near Share that offers copy and save', () => {
    expect(app).toContain('aria-label="Capture screenshot"');
    expect(app).toContain("captureScreenshot('copy')");
    expect(app).toContain("captureScreenshot('save')");
  });

  it('captures via the offscreen Canvas2D renderer seam with clipboard + download paths', () => {
    expect(app).toContain('captureSceneBlob({');
    expect(app).toContain("new ClipboardItem({ 'image/png': blob })");
    expect(app).toContain('downloadBlob(blob, screenshotFilename(activeDiagramSurface.title');
  });
});

describe('production dev-mode gate', () => {
  it('defaults dev mode off, persists it, and toggles with Shift+Alt+D', () => {
    expect(app).toContain("localStorage.getItem('okie.devMode') === '1'");
    expect(app).toContain("localStorage.setItem('okie.devMode', devMode ? '1' : '0')");
    expect(app).toContain('shouldToggleDevMode(event)');
    expect(app).toContain('setDevMode(value => !value)');
    expect(app).toContain("data-dev-mode={devMode ? 'true' : 'false'}");
  });

  it('forces view mode and closes diagnostics when dev mode is off', () => {
    expect(app).toContain("if (!devMode) { setInteractionMode('view'); setDiagnosticsOpen(false); }");
  });

  it('gates the renderer pill, diagnostics panel, mode toggle, and create-diagram menu behind dev mode', () => {
    expect(app).toContain('{devMode && <button aria-expanded={diagnosticsOpen}');
    expect(app).toContain('{devMode && diagnosticsOpen && <aside className="diagnostics-card"');
    expect(app).toContain('{devMode && <div aria-label="Diagram interaction mode"');
    expect(app).toContain('{devMode && <details className="diagram-add-menu"');
  });
});

describe('selected relationship focus wiring', () => {
  it('keeps transient endpoint/path promotion behind story selection ownership', () => {
    expect(app).toContain("currentStory === undefined || storyPhase === 'idle' || storySelectionOverride ? pickedRelationId : undefined");
    expect(app).toContain('relationFocusIds={relationFocus.endpointIds}');
    expect(app).toContain('projectionOverride={relationFocus.projectionOverride}');
    expect(app).toContain('new Set([...storyFocus.requiredIds, ...relationFocus.endpointIds])');
  });

  it('resolves selected route handles from the retained projected relation and carries its own detail', () => {
    expect(app).toContain('selectedProjectedRelationForFocus(scene, selectedRelationId, projectionOverride, authoringDetail)');
    expect(app).toContain('detail: authoringPointer.detail');
    expect(app).toContain("selectedRoute={authoringTool === 'select'\n          ? guideDraft ? undefined : selectedProjectedRoute");
    expect(app).toContain('guideDraft ? { points: guideDraft.points, safe: guideDraft.applied }');
    expect(app).not.toContain('projectedRelationsByDetail[authoringDetail]\n            .find(relation => relation.id === selectedRelationId');
  });
});
