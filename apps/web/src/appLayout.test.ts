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
    expect(css).toContain('.notation-readiness-list');
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

  it('enables the Source tab from inspectorCanShowSource rather than a hardcoded disable', () => {
    expect(app).toContain('inspectorCanShowSource(selected, { pickedRelation: Boolean(pickedRelation) })');
    expect(app).toContain('inspectorTabForEntity(inspectorCanShowSource(entity), intent)');
    expect(app).toContain('disabled={!sourceAvailable} id="source-tab"');
    expect(app).not.toContain("selected.detail === 'code' && Boolean(selectedExcerpt)");
    expect(app).not.toContain("entity.detail === 'code' && Boolean(entity.sourceExcerpts?.length)");
  });

  it('renders an accepted section summary in Details and omits empty enrich copy', () => {
    expect(app).toContain('inspectorAcceptedSummary(selected)');
    expect(app).toContain("data-inspector-has-section-summary={selectedSummary ? 'true' : 'false'}");
    expect(app).toContain('data-inspector-section-summary=""');
    expect(app).toContain('{selectedSummary ? <p className="responsibility" data-inspector-section-summary="">{selectedSummary}</p> : null}');
    expect(app).not.toContain('<p className="responsibility">{selected.responsibility}</p>');
  });

  it('renders observed CODEOWNERS in Details and omits the section when none exist', () => {
    expect(app).toContain('inspectorPathOwners(selected)');
    expect(app).toContain("data-inspector-has-owners={selectedOwners.length ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-section=\"ownership\"");
    expect(app).toContain('<h3>Owned by</h3>');
    expect(app).toContain('{selectedOwners.length > 0 ?');
    expect(app).toContain('data-testid="inspector-owners"');
  });

  it('renders observed McCabe cyclomatic in Details and flags complexity over 6', () => {
    expect(app).toContain('inspectorCyclomatic(selected)');
    expect(app).toContain("data-inspector-has-cyclomatic={selectedCyclomatic ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-cyclomatic-flagged={selectedCyclomatic?.flagged ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-section=\"cyclomatic\"");
    expect(app).toContain('<h3>Complexity</h3>');
    expect(app).toContain('data-testid="inspector-cyclomatic"');
    expect(app).toContain('McCabe {selectedCyclomatic.complexity}');
    expect(app).toContain('Over 6');
  });

  it('samples C4 completeness advisories in Details instead of dumping the full list', () => {
    expect(app).toContain('presentInspectorNotationDiagnostics(notationDiagnostics');
    expect(app).toContain('inspectorNotationScope({');
    expect(app).toContain('selectedId: selected.id');
    expect(app).toContain('data-testid="inspector-notation"');
    expect(app).toContain('data-inspector-notation-total={notationPresentation.total}');
    expect(app).toContain('data-inspector-notation-hidden={notationPresentation.hiddenCount}');
    expect(app).toContain('notationPresentation.errors.length');
    expect(app).toContain('+${notationPresentation.hiddenCount} more completeness notes');
    expect(app).not.toContain('notationDiagnostics.map');
  });

  it('grounds Ask Atlas in selected or isolated packets and keeps the disconnected explanation path', () => {
    expect(app).toContain("data-ask-connected={askConnected ? 'true' : 'false'}");
    expect(app).toContain('data-ask-state={askState}');
    expect(app).toContain('buildAskContext(');
    expect(app).toContain('probeAskConnection');
    expect(app).toContain("isolateActive: visibilityMode === 'isolate'");
    expect(app).toContain('playDisconnectedAsk()');
    expect(app).toContain('ASK_NOT_CONNECTED_LIVE_MESSAGE');
    expect(app).toContain('ASK_NOT_CONNECTED_COPY');
    expect(app).toContain('ASK_CONNECTED_COPY');
    expect(app).toContain('shouldCommitAskAnswer(submittedScopeKey, askScopeKeyRef.current)');
    expect(app).toContain('currentAskScopeKey');
  });

  it('publishes stable relation-summary hooks and presents the destination before relation metadata', () => {
    expect(app).toContain('data-inspector-presentation="relation-summary"');
    expect(app).toContain('data-inspector-relation-id={row.relationId}');
    expect(app).toContain('data-inspector-relation-edge-id={row.id}');
    expect(app).toContain('<strong>{row.counterpart.name}</strong><small>{row.label}');
    expect(app).toContain('onClick={() => inspectCanvasRelation(row)}');
    expect(app).toContain("inspectRelation(relation, 'panel', 'preserve');");
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
    expect(app).toContain('canvasRelationsForEntity(scene, activeProjectionRelationIds, selected.id, activeDetail)');
  });

  it('filters Isolate Relationships by visual endpoints, not canonical from/to', () => {
    expect(app).toContain('canvasRelationRowsInIsolate(related, selected.id, isolatedEntityIdSet)');
    expect(app).not.toContain('row.semanticIds.some(id => isolatedRelationIdSet.has(id))');
    expect(app).toContain('canvasRelationsForEntity(scene, activeProjectionRelationIds, selected.id, activeDetail)');
  });

  it('follows the canvas in Relationships and keeps both remainders honest', () => {
    const relationships = app.indexOf('<h3>Relationships</h3>');
    const omitted = app.indexOf('data-testid="relationships-omitted-more"', relationships);
    const hidden = app.indexOf('data-testid="relationships-hidden-internal"', relationships);

    expect(omitted).toBeGreaterThan(relationships);
    expect(hidden).toBeGreaterThan(relationships);
    // "+N more" only when omittedEdges actually contributed; "Hiding N" is internals.
    expect(app).toContain('canvasRelations.omittedEdgeCount > 0 &&');
    expect(app).toContain('+{canvasRelations.omittedRelationCount} more not routed at this zoom');
    expect(app).toContain('canvasRelations.hiddenInternalCount > 0 &&');
    expect(app).toContain('const collapsed = row.count > 1 ? ` · ${row.count} relationships` : \'\';');
    expect(app).not.toContain('data-testid="omitted-relations"');
    expect(app).not.toContain('Not drawn at this zoom');
    expect(app).not.toContain('aggregated out of the routed view');
  });

  it('keeps +N more compact until the remainder is opened, then enumerates omitted relations', () => {
    expect(app).toContain('const [omittedRemainderExpanded, setOmittedRemainderExpanded] = useState(false)');
    expect(app).toContain('paintedOmittedRelationRows(canvasRelations.omittedRows, omittedRemainderExpanded)');
    expect(app).toContain('aria-expanded={omittedRemainderExpanded}');
    expect(app).toContain('setOmittedRemainderExpanded(open => !open)');
    expect(app).toContain('canvasRelations.omittedEdgeCount > 0 && omittedRemainderExpanded ? <div className="relations-omitted-list" data-testid="relationships-omitted-list">');
    expect(app).toContain('data-omitted-relation-id={row.relationId}');
    expect(app).toContain('{row.fromName} → {row.toName}');
    expect(app).toContain("setOmittedRemainderExpanded(false)");
    expect(app).not.toContain('scene.omittedRelations.map');
  });

  it('never moves the camera on selection, only on an explicit camera intent', () => {
    const focusStart = app.indexOf('function focusEntity(');
    const focusEnd = app.indexOf('function navigateInspectorHierarchy', focusStart);
    const implementation = app.slice(focusStart, focusEnd);

    expect(implementation).toContain("const explicitCameraIntent = cameraIntent === 'frame' || inspectorIntent === 'source';");
    expect(implementation).toContain("if (explicitCameraIntent) reframeEntityAfterInspectorChange(entity, nextInspectorTab === 'source');");
    expect(implementation).toContain("const nextCamera = cameraIntent === 'frame'");
    expect(implementation.match(/reframeEntityAfterInspectorChange\(/g)).toHaveLength(1);
  });

  it('selects a Relationships row without framing; Show on map frames the flow', () => {
    const inspectStart = app.indexOf('function inspectRelation(');
    const inspectCanvasStart = app.indexOf('function inspectCanvasRelation');
    const inspectEnd = app.indexOf('function restoreInspectorHistoryNavigation', inspectStart);
    const handlePickStart = app.indexOf('function handlePick(');
    const handlePickEnd = app.indexOf('function closeDetails(', handlePickStart);
    const inspectImplementation = app.slice(inspectStart, inspectCanvasStart);
    const inspectCanvasImplementation = app.slice(inspectCanvasStart, inspectEnd);
    const handlePickImplementation = app.slice(handlePickStart, handlePickEnd);

    expect(inspectImplementation).toContain("cameraIntent: 'preserve' | 'frame' = 'frame'");
    expect(inspectImplementation).toContain("if (cameraIntent === 'frame') frameSelectedRelationFlow(relation, owner); else inspectorReframeGenerationRef.current += 1;");
    expect(inspectImplementation.match(/frameSelectedRelationFlow\(/g)).toHaveLength(1);
    expect(inspectCanvasImplementation).toContain("inspectRelation(relation, 'panel', 'preserve')");
    expect(inspectCanvasImplementation).not.toContain("cameraIntent === 'frame'");
    expect(app).toContain('onClick={() => inspectCanvasRelation(row)}');
    expect(app).toContain('onClick={() => pickedRelation && frameSelectedRelationFlow(pickedRelation, selected)}');
    expect(app.match(/<FitIcon size=\{15\}\/> Show on map/g)).toHaveLength(2);
    expect(handlePickImplementation).toContain('inspectRelation(relation);');
    expect(handlePickImplementation).not.toContain('inspectRelation(relation,');
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
    expect(app).toContain("inspectRelation(relation, 'panel', 'preserve')");
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
  it('renders an interactive minimap inset that pans the camera through the canvas path', () => {
    // Drag/click on the inset routes camera writes through the same primitives as canvas pan:
    // live moves via setCamera, and settle/click via navigateCamera(..., 'replace') so story +
    // flight cancellation, bounds and replace-not-push URL semantics stay on one path. A
    // finished pan also runs the same stationary-pan lens handoff as a canvas drag, so the
    // node the user panned to takes lens ownership and reveals its interior.
    expect(app).toContain("navigateCamera(next, 'replace', 'Panned the map overview');");
    expect(app).toContain("if (phase === 'settle') stabilizeSemanticLensForPan(next);");
    expect(app.slice(app.indexOf('<Minimap'))).toContain("if (phase === 'move') {");
    // The container stays inert; the inset SVG is the sole pointer hit target.
    expect(declarations(css, '.minimap')).toContain('pointer-events: none');
    expect(declarations(css, '.minimap')).toContain('position: absolute');
    expect(declarations(css, '.minimap svg')).toContain('pointer-events: auto');
  });

  it('hides the minimap on very narrow viewports', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 390px)'));
    expect(declarations(narrow, '.minimap')).toContain('display: none');
  });

  it('publishes the per-frame rendered camera so the minimap can track gestures in real time', () => {
    // React `camera` state is throttled/settled, so the render loop broadcasts the live camera
    // to the minimap via the per-frame bridge (imperative, no 60fps React re-render).
    expect(app).toContain('publishLiveCamera(liveCameraRef.current)');
    expect(app).toContain("import { publishLiveCamera } from './liveCameraBridge'");
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

describe('Mermaid import onto the atlas (CLA-35)', () => {
  it('exposes a first-class import path on the atlas, not behind dev mode', () => {
    expect(app).toContain('data-testid="import-mermaid"');
    expect(app).toContain('aria-label="Import Mermaid diagram"');
    expect(app).toContain('<ImportMermaidDialog');
    expect(app).toContain('applyImportedMermaid');
    expect(app).toContain("data-atlas-source={importedAtlas ? 'imported-mermaid'");
    expect(app).not.toContain('{devMode && <ImportMermaidDialog');
    expect(css).toContain('.import-mermaid-dialog');
  });

  it('compiles imported mermaid through the atlas scene path and leaves scan-from-repo in place', () => {
    expect(app).toContain('compileImportedMermaidScene');
    expect(app).toContain('importMermaidToAtlas');
    expect(app).toContain("setLiveMessage(result.message)");
    expect(app).toContain('The atlas is unchanged.');
    expect(app).toContain('createArchitectureAuthoringDocument(result.atlas.snapshot.repositoryId)');
    expect(app).toContain('authoring?.repositoryId === imported.snapshot.repositoryId');
    expect(app).toContain("scanFixture ? 'scan' : 'golden'");
    const landing = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(landing).toContain('Map a repository');
    expect(landing).toContain('aria-label="GitHub repository URL"');
    expect(landing).toContain('Scan');
  });
});

describe('selected relationship focus wiring', () => {
  it('keeps transient endpoint/path promotion behind story selection ownership', () => {
    expect(app).toContain("currentStory === undefined || storyPhase === 'idle' || storySelectionOverride ? pickedRelationId : undefined");
    expect(app).toContain('relationFocusIds={relationFocus.endpointIds}');
    expect(app).toContain('projectionOverride={relationFocus.projectionOverride}');
    expect(app).toContain('new Set([...storyFocus.requiredIds, ...relationFocus.endpointIds])');
  });

  it('lifts isolate from a code story step to the file-component neighborhood', () => {
    expect(app).toContain('isolateNeighborhoodIds(scene.entities, visibilityFocusIds');
    expect(app).toContain('liftCodeStoryFocus:');
    expect(app).toContain("visibilityMode === 'isolate' ? isolatedEntityIdSet : storyFocus.focusedIds");
  });

  it('resolves selected route handles from the retained projected relation and carries its own detail', () => {
    expect(app).toContain('selectedProjectedRelationForFocus(scene, selectedRelationId, projectionOverride, authoringDetail)');
    expect(app).toContain('detail: authoringPointer.detail');
    expect(app).toContain("selectedRoute={authoringTool === 'select'\n          ? guideDraft ? undefined : selectedProjectedRoute");
    expect(app).toContain('guideDraft ? { points: guideDraft.points, safe: guideDraft.applied }');
    expect(app).not.toContain('projectedRelationsByDetail[authoringDetail]\n            .find(relation => relation.id === selectedRelationId');
  });
});
