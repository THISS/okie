import { describe, expect, it } from 'vitest';
import {
  MAIN_DIAGRAM_SURFACE_ID,
  activateDiagramSurface,
  closeDiagramSurface,
  createDiagramWorkspace,
  diagramWorkspaceSurfaces,
  openDerivedDiagramSurface,
  updateDiagramSurfaceSession,
  type DiagramSurfaceSession,
  type DerivedDiagramSurface,
} from './diagramWorkspace';

const session = (selectedId: string, open = true): DiagramSurfaceSession => ({
  camera: { x: 10, y: 20, zoom: 2 },
  selectedId,
  inspector: { open, tab: 'details', subjectId: selectedId },
});

const flow = (id: string, selectedId = 'component:flow'): DerivedDiagramSurface => ({
  id,
  kind: 'flow',
  title: 'Request flow',
  closable: true,
  entityIds: [selectedId],
  session: { selectedElementId: selectedId, inspector: { open: false, tab: 'details' } },
});

describe('diagram workspace', () => {
  it('pins Main first and makes closing it a no-op', () => {
    const initial = createDiagramWorkspace(session('system:main'));
    expect(diagramWorkspaceSurfaces(initial).map(surface => surface.id)).toEqual([MAIN_DIAGRAM_SURFACE_ID]);
    expect(initial.surfaces[MAIN_DIAGRAM_SURFACE_ID]).toMatchObject({ title: 'Main', closable: false });
    expect(closeDiagramSurface(initial, MAIN_DIAGRAM_SURFACE_ID, session('system:changed'))).toBe(initial);
  });

  it('captures the active session while opening and switching surfaces', () => {
    const initial = createDiagramWorkspace(session('system:main'));
    const opened = openDerivedDiagramSurface(initial, flow('diagram:flow:1'), session('component:saved-main'));
    expect(opened.activeSurfaceId).toBe('diagram:flow:1');
    expect(opened.surfaces[MAIN_DIAGRAM_SURFACE_ID]?.session.selectedId).toBe('component:saved-main');

    const switched = activateDiagramSurface(opened, MAIN_DIAGRAM_SURFACE_ID, session('component:saved-flow', false));
    expect(switched.activeSurfaceId).toBe(MAIN_DIAGRAM_SURFACE_ID);
    expect(switched.surfaces['diagram:flow:1']?.session).toMatchObject({
      selectedId: 'component:saved-flow',
      inspector: { open: false },
    });
  });

  it('closes derived tabs only and activates the nearest tab to the left', () => {
    const initial = createDiagramWorkspace(session('system:main'));
    const first = openDerivedDiagramSurface(initial, flow('diagram:flow:1'), session('system:main'));
    const second = openDerivedDiagramSurface(first, { ...flow('diagram:code:2'), kind: 'code', title: 'Code path' }, first.surfaces[first.activeSurfaceId]!.session);
    const closed = closeDiagramSurface(second, 'diagram:code:2', second.surfaces[second.activeSurfaceId]!.session);

    expect(closed.activeSurfaceId).toBe('diagram:flow:1');
    expect(closed.order).toEqual([MAIN_DIAGRAM_SURFACE_ID, 'diagram:flow:1']);
    expect(closed.surfaces['diagram:code:2']).toBeUndefined();
  });

  it('keeps selection and inspector state isolated per derived surface', () => {
    const initial = createDiagramWorkspace(session('system:main'));
    const opened = openDerivedDiagramSurface(initial, flow('diagram:flow:1'), session('system:main'));
    const selected = updateDiagramSurfaceSession(opened, 'diagram:flow:1', {
      selectedElementId: 'component:worker',
      inspector: { open: true, tab: 'details', subjectId: 'component:worker' },
    });

    expect(selected.surfaces['diagram:flow:1']?.session.selectedElementId).toBe('component:worker');
    expect(selected.surfaces[MAIN_DIAGRAM_SURFACE_ID]?.session.selectedId).toBe('system:main');
  });
});
