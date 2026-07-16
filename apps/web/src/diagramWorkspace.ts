import type { Camera } from './renderer/types';

export const MAIN_DIAGRAM_SURFACE_ID = 'diagram:main';

export type DerivedDiagramKind = 'flow' | 'mermaid' | 'code';
export type DiagramSurfaceKind = 'main' | DerivedDiagramKind;

export type DiagramInspectorSession = {
  open: boolean;
  tab: 'details' | 'source';
  subjectId?: string;
};

export type DiagramSurfaceSession = {
  camera?: Camera;
  selectedId?: string;
  pickedRelationId?: string;
  selectedElementId?: string;
  inspector: DiagramInspectorSession;
};

export type MainDiagramSurface = {
  id: typeof MAIN_DIAGRAM_SURFACE_ID;
  kind: 'main';
  title: 'Main';
  closable: false;
  session: DiagramSurfaceSession;
};

export type DerivedDiagramSurface = {
  id: string;
  kind: DerivedDiagramKind;
  title: string;
  closable: true;
  entityIds: string[];
  session: DiagramSurfaceSession;
};

export type DiagramSurface = MainDiagramSurface | DerivedDiagramSurface;

export type DiagramWorkspaceState = {
  activeSurfaceId: string;
  order: string[];
  surfaces: Record<string, DiagramSurface>;
};

function withSession(surface: DiagramSurface, session: DiagramSurfaceSession): DiagramSurface {
  return { ...surface, session } as DiagramSurface;
}

export function createDiagramWorkspace(mainSession: DiagramSurfaceSession): DiagramWorkspaceState {
  const main: MainDiagramSurface = {
    id: MAIN_DIAGRAM_SURFACE_ID,
    kind: 'main',
    title: 'Main',
    closable: false,
    session: mainSession,
  };
  return {
    activeSurfaceId: main.id,
    order: [main.id],
    surfaces: { [main.id]: main },
  };
}

export function diagramWorkspaceSurfaces(state: DiagramWorkspaceState): DiagramSurface[] {
  return state.order.map(id => state.surfaces[id]).filter((surface): surface is DiagramSurface => Boolean(surface));
}

export function updateDiagramSurfaceSession(
  state: DiagramWorkspaceState,
  surfaceId: string,
  session: DiagramSurfaceSession,
): DiagramWorkspaceState {
  const surface = state.surfaces[surfaceId];
  if (!surface) return state;
  return {
    ...state,
    surfaces: { ...state.surfaces, [surfaceId]: withSession(surface, session) },
  };
}

export function activateDiagramSurface(
  state: DiagramWorkspaceState,
  surfaceId: string,
  currentSession: DiagramSurfaceSession,
): DiagramWorkspaceState {
  if (!state.surfaces[surfaceId]) return state;
  const captured = updateDiagramSurfaceSession(state, state.activeSurfaceId, currentSession);
  return surfaceId === captured.activeSurfaceId ? captured : { ...captured, activeSurfaceId: surfaceId };
}

export function openDerivedDiagramSurface(
  state: DiagramWorkspaceState,
  surface: DerivedDiagramSurface,
  currentSession: DiagramSurfaceSession,
): DiagramWorkspaceState {
  if (surface.id === MAIN_DIAGRAM_SURFACE_ID) return state;
  const captured = updateDiagramSurfaceSession(state, state.activeSurfaceId, currentSession);
  if (captured.surfaces[surface.id]) return { ...captured, activeSurfaceId: surface.id };
  return {
    activeSurfaceId: surface.id,
    order: [...captured.order, surface.id],
    surfaces: { ...captured.surfaces, [surface.id]: surface },
  };
}

export function closeDiagramSurface(
  state: DiagramWorkspaceState,
  surfaceId: string,
  currentSession: DiagramSurfaceSession,
): DiagramWorkspaceState {
  const surface = state.surfaces[surfaceId];
  if (!surface || !surface.closable || surfaceId === MAIN_DIAGRAM_SURFACE_ID) return state;
  const captured = updateDiagramSurfaceSession(state, state.activeSurfaceId, currentSession);
  const closingIndex = captured.order.indexOf(surfaceId);
  const order = captured.order.filter(id => id !== surfaceId);
  const surfaces = { ...captured.surfaces };
  delete surfaces[surfaceId];
  const activeSurfaceId = captured.activeSurfaceId === surfaceId
    ? order[Math.max(0, closingIndex - 1)] ?? MAIN_DIAGRAM_SURFACE_ID
    : captured.activeSurfaceId;
  return { activeSurfaceId, order, surfaces };
}
