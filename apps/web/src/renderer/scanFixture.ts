import {
  validateSnapshot,
  validateStoryDocument,
  validateView,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type C4Band,
  type EntityKind,
  type ValidationIssue,
} from '@okie/architecture';
import { compileAppStoryPlan, createC4Scene, type AppStoryPlan } from './goldenC4Scene';
import type { AtlasScene } from './types';

// Scan-mode scoped-compile thresholds (documented; Okie's scan sits under all of
// them, so its scenes/interactions stay identical to an unbounded compile).
export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;        // repo-size gate for band depth
export const SCAN_EDGE_BUDGET_MIN_SCOPE_RELATIONS = 250; // scope-density gate for the edge budget
export const SCAN_EDGE_BUDGET_PER_BAND = 20;             // routed edges per band once dense

const SCAN_MAX_BAND_BY_KIND: Partial<Record<EntityKind, C4Band>> = {
  person: 'container',
  softwareSystem: 'container',
  externalSystem: 'container',
  boundary: 'container',
  container: 'component',
  dataStore: 'component',
  queue: 'component',
  // component / code focus stays unbounded (its deepest bands already route)
};

/** Relations fully inside the focus subtree — the deterministic density signal. */
function scanScopeRelationCount(snapshot: ArchitectureSnapshot, focusEntityId: string): number {
  const childrenByParent = new Map<string, string[]>();
  for (const entity of snapshot.entities) {
    if (!entity.parentId) continue;
    const siblings = childrenByParent.get(entity.parentId) ?? [];
    siblings.push(entity.id);
    childrenByParent.set(entity.parentId, siblings);
  }
  const subtree = new Set<string>();
  const stack = [focusEntityId];
  while (stack.length) {
    const id = stack.pop()!;
    if (subtree.has(id)) continue;
    subtree.add(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  return snapshot.relations.filter(relation => subtree.has(relation.from) && subtree.has(relation.to)).length;
}

/**
 * Deterministic scoped-compile options for a scan-mode focus: band depth (drill
 * mapping) only for large repos so small repos like Okie stay unbounded/identical,
 * and a per-band edge budget only when the focused scope is dense. Both gates
 * derive from snapshot/scope stats, never from timing.
 */
export function scanScopeCompileOptions(
  snapshot: ArchitectureSnapshot,
  focusEntityId: string,
): { maxBand?: C4Band; maxEdgesPerBand?: number } {
  const options: { maxBand?: C4Band; maxEdgesPerBand?: number } = {};
  if (snapshot.entities.length > SCAN_BAND_DEPTH_MIN_ENTITIES) {
    const focus = snapshot.entities.find(entity => entity.id === focusEntityId);
    const maxBand = focus && SCAN_MAX_BAND_BY_KIND[focus.kind];
    if (maxBand) options.maxBand = maxBand;
  }
  if (scanScopeRelationCount(snapshot, focusEntityId) > SCAN_EDGE_BUDGET_MIN_SCOPE_RELATIONS) {
    options.maxEdgesPerBand = SCAN_EDGE_BUDGET_PER_BAND;
  }
  return options;
}

export type ScanNavigationDefaults = {
  repositoryId: string;
  snapshotId: string;
  viewId: string;
  rootEntityId: string;
};

/** A validated, live-compiled scanned snapshot ready to drive the app shell. */
export type ScanFixture = {
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  story: AppStoryPlan;
  /** Recompiles the scan snapshot for a new focus/root (drill-in, restore). */
  createScene: (focusEntityId: string, previous?: AtlasScene) => AtlasScene;
  navigation: ScanNavigationDefaults;
};

export type RawScanTrio = { snapshot: unknown; view: unknown; story: unknown };
export type ScanTrioLoader = (name: 'snapshot' | 'view' | 'story') => Promise<unknown>;

/** Raised when the scanned trio fails validation; carries every issue found. */
export class ScanFixtureError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Scanned snapshot failed validation:\n${formatScanIssues(issues)}`);
    this.name = 'ScanFixtureError';
    this.issues = issues;
  }
}

export function formatScanIssues(issues: ValidationIssue[]): string {
  return issues.map(issue => `• ${issue.path ? `${issue.path} — ` : ''}${issue.message}`).join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopedValidate(label: string, validate: () => ValidationIssue[]): ValidationIssue[] {
  try {
    return validate().map(issue => ({ path: issue.path ? `${label}.${issue.path}` : label, message: issue.message }));
  } catch (error) {
    return [{ path: label, message: error instanceof Error ? error.message : 'is structurally invalid' }];
  }
}

/**
 * Validates the raw scan trio and compiles it into a live ScanFixture through the
 * exact same path the demo uses (createC4Scene → buildC4ProjectionBundle →
 * compileC4Scene). Throws ScanFixtureError with every issue rather than returning
 * a partial fixture, so an invalid scan can never render silently. Pure (fetch is
 * separate), so it is exercised directly in tests with the demo fixtures as input.
 */
export function compileScanFixture(raw: RawScanTrio): ScanFixture {
  const shapeIssues: ValidationIssue[] = [];
  if (!isRecord(raw.snapshot)) shapeIssues.push({ path: 'snapshot', message: 'must be a JSON object' });
  if (!isRecord(raw.view)) shapeIssues.push({ path: 'view', message: 'must be a JSON object' });
  if (!isRecord(raw.story)) shapeIssues.push({ path: 'story', message: 'must be a JSON object' });
  if (shapeIssues.length) throw new ScanFixtureError(shapeIssues);

  const snapshot = raw.snapshot as ArchitectureSnapshot;
  const view = raw.view as ArchitectureView;
  const issues: ValidationIssue[] = [
    ...scopedValidate('snapshot', () => validateSnapshot(snapshot)),
    ...scopedValidate('view', () => validateView(snapshot, view)),
    ...scopedValidate('story', () => validateStoryDocument(snapshot, view, raw.story)),
  ];
  if (issues.length) throw new ScanFixtureError(issues);

  let story: AppStoryPlan;
  try {
    story = compileAppStoryPlan(snapshot, view, raw.story as ArchitectureStory);
  } catch (error) {
    throw new ScanFixtureError([{ path: 'story', message: error instanceof Error ? error.message : String(error) }]);
  }

  const createScene = (focusEntityId: string, previous?: AtlasScene): AtlasScene => createC4Scene({
    baseSnapshot: snapshot,
    rootEntityId: view.rootEntityId,
    focusEntityId,
    familyId: `view-family:${snapshot.repositoryId}:${focusEntityId}`,
    sceneId: `scan:${snapshot.repositoryId}:c4`,
    title: view.name,
    subtitle: `scanned snapshot · ${snapshot.commitSha.slice(0, 12)}`,
    frozenRevision: snapshot.commitSha,
    previous,
    ...scanScopeCompileOptions(snapshot, focusEntityId),
  });

  return {
    snapshot,
    view,
    story,
    createScene,
    navigation: {
      repositoryId: snapshot.repositoryId,
      snapshotId: snapshot.id,
      viewId: view.id,
      rootEntityId: view.rootEntityId,
    },
  };
}

// import.meta.glob tolerates a missing fixtures/scan/ at build time (it resolves
// to an empty map) — unlike a static import(), which would break `pnpm build`
// on a fresh checkout where the gitignored scan output has not been generated.
const scanDocLoaders = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/{snapshot,view,story}.json');

async function fetchScanDoc(name: 'snapshot' | 'view' | 'story'): Promise<unknown> {
  const key = Object.keys(scanDocLoaders).find(path => path.endsWith(`/${name}.json`));
  if (!key) {
    throw new ScanFixtureError([{
      path: name,
      message: `fixtures/scan/${name}.json was not found — run okie-scan to generate the snapshot trio`,
    }]);
  }
  const module = await scanDocLoaders[key]!();
  return module.default;
}

/**
 * Fetches the scanned trio from the gitignored fixtures/scan/ path (served by the
 * dev server, like the stress fixture) and compiles it. The loader is injectable
 * so tests can drive the validate/error path without real files on disk.
 */
export async function loadScanFixture(load: ScanTrioLoader = fetchScanDoc): Promise<ScanFixture> {
  const [snapshot, view, story] = await Promise.all([load('snapshot'), load('view'), load('story')]);
  return compileScanFixture({ snapshot, view, story });
}
