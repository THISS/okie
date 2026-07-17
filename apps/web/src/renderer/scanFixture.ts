import {
  validateSnapshot,
  validateStoryDocument,
  validateView,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type ValidationIssue,
} from '@okie/architecture';
import { compileAppStoryPlan, createC4Scene, type AppStoryPlan } from './goldenC4Scene';
import type { AtlasScene } from './types';

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
const scanDocLoaders = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/*.json');

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
