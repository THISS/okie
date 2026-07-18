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
import type { AtlasScene, ScanGuardRefusal } from './types';

// Scan-mode scoped-compile levers (documented; Okie's scan sits under the size
// gate, so scanScopeCompileOptions returns {} → identical to an unbounded compile).
// Scoping exists FOR large repos; small repos keep the uninterrupted full-band
// zoom that is the product's signature feel.
export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000; // size gate — below this, no scoping
export const SCAN_CONTAINER_EDGE_BUDGET = 24;     // routed edges per band at a container drill-in
export const SCAN_CONTAINER_GRID_NODES = 1500;    // router grid-node cap at a container drill-in

export type ScanScopedOptions = { maxBand?: C4Band; maxEdgesPerBand?: number; maxGridNodes?: number };

/**
 * Mode-level compile options for scan mode (task #30). Unlike ScanScopedOptions these
 * are NOT gated by the scoped-compile size threshold — they apply to every scan compile
 * at any repo size, because the tall-container problem (a system packing into one narrow
 * column) shows up on repos well below the scoped-compile gate (e.g. Okie's own scan).
 * `targetAspect` is chosen once by the client at bootstrap (device orientation) and is a
 * deterministic compile input, never the live viewport.
 */
export type ScanModeOptions = { targetAspect?: number };

// Per-focus-kind scoped options, applied only above the size gate.
const SCAN_SCOPED_OPTIONS_BY_KIND: Partial<Record<EntityKind, ScanScopedOptions>> = {
  person: { maxBand: 'container' },
  softwareSystem: { maxBand: 'container' },
  externalSystem: { maxBand: 'container' },
  boundary: { maxBand: 'container' },
  container: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES },
  dataStore: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES },
  queue: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES },
  component: { maxBand: 'code' },
  // code focus → {} (deepest bands already route; no caps)
};

/**
 * Deterministic scoped-compile options for a scan-mode focus. A single repo-size
 * gate (entity count > threshold) turns scoping ON for large repos; below it,
 * small repos like Okie stay fully unbounded and render identically to today.
 * Above the gate, options follow the focus kind: system→container band; container
 * drill-in→component band + edge budget + router grid cap; component→code band.
 * Pure function of snapshot + focus (never timing).
 */
export function scanScopeCompileOptions(snapshot: ArchitectureSnapshot, focusEntityId: string): ScanScopedOptions {
  if (snapshot.entities.length <= SCAN_BAND_DEPTH_MIN_ENTITIES) return {};
  const focus = snapshot.entities.find(entity => entity.id === focusEntityId);
  const scoped = focus && SCAN_SCOPED_OPTIONS_BY_KIND[focus.kind];
  return scoped ? { ...scoped } : {};
}

/**
 * True when these options bound the routed node set for ANY repo size — so the
 * compile can never route the whole graph. A router-grid cap bounds the layout
 * outright; without one, only the shallow bands (context/container) hold a
 * bounded node set (deeper component/code bands can pull in the entire tree, so
 * they must carry a grid cap). This is the property the guard requires above the
 * gate; it is intentionally independent of the compile respecting the options, so
 * a stale (pre-scoping) package build cannot make it lie.
 */
function optionsBoundRouting(options: ScanScopedOptions): boolean {
  if (options.maxGridNodes !== undefined) return true;
  return options.maxBand === 'context' || options.maxBand === 'container';
}

/**
 * Cheap, deterministic size of a focus scope WITHOUT compiling: the entities that
 * are descendant-or-self of the focus (the set a full-depth `code`-band compile
 * routes), plus the relations that touch them. O(entities + relations). Used by
 * the guard to decide whether an unbounded compile is safe. Returns zeros for an
 * unknown focus (the compile itself will reject it — never a hang).
 */
export function scanScopeStats(
  snapshot: ArchitectureSnapshot,
  focusEntityId: string,
): { entityCount: number; relationCount: number } {
  if (!snapshot.entities.some(entity => entity.id === focusEntityId)) {
    return { entityCount: 0, relationCount: 0 };
  }
  const childrenByParent = new Map<string, string[]>();
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    const siblings = childrenByParent.get(entity.parentId);
    if (siblings) siblings.push(entity.id);
    else childrenByParent.set(entity.parentId, [entity.id]);
  }
  const inScope = new Set<string>();
  const stack = [focusEntityId];
  while (stack.length) {
    const id = stack.pop()!;
    if (inScope.has(id)) continue;
    inScope.add(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  let relationCount = 0;
  for (const relation of snapshot.relations) {
    if (inScope.has(relation.from) || inScope.has(relation.to)) relationCount += 1;
  }
  return { entityCount: inScope.size, relationCount };
}

export type ScanGuardDecision = {
  /** The focus that will actually be compiled — the fallback when refused. */
  focusEntityId: string;
  /** Scoped-compile options for `focusEntityId` (always bounded when refused). */
  options: ScanScopedOptions;
  /** Present only when the requested focus was refused. */
  refusal?: ScanGuardRefusal;
};

/**
 * The hard anti-hang guard for scan-mode compiles, and the single choke point all
 * scan compiles pass through. Derives scoped options for the requested focus and,
 * ABOVE the size gate, refuses any focus whose scope exceeds the gate when no
 * option bounds the routing (an unbounded full-graph compile — the deep-link hang
 * vector, and the failure mode a stale package build reintroduces on every path).
 * On refusal it substitutes the scoped fallback focus (the view root), forcing a
 * guaranteed-bounded band if even the fallback derives no constraint, so the app
 * renders a safe scene instead of freezing.
 *
 * A provable no-op below the gate: options are always {} there and the gate check
 * short-circuits before any scope walk, so Okie-sized snapshots are never touched.
 * Pure — counts entities/relations, never compiles.
 */
export function guardScanCompile(
  snapshot: ArchitectureSnapshot,
  requestedFocusId: string,
  fallbackFocusId: string,
): ScanGuardDecision {
  const options = scanScopeCompileOptions(snapshot, requestedFocusId);
  if (snapshot.entities.length <= SCAN_BAND_DEPTH_MIN_ENTITIES) {
    return { focusEntityId: requestedFocusId, options };
  }
  if (optionsBoundRouting(options)) {
    return { focusEntityId: requestedFocusId, options };
  }
  const stats = scanScopeStats(snapshot, requestedFocusId);
  if (stats.entityCount <= SCAN_BAND_DEPTH_MIN_ENTITIES) {
    // Unbounded options, but a genuinely small scope (e.g. a `code` leaf) never
    // explodes — compile it as requested.
    return { focusEntityId: requestedFocusId, options };
  }
  const fallbackOptions = scanScopeCompileOptions(snapshot, fallbackFocusId);
  return {
    focusEntityId: fallbackFocusId,
    options: optionsBoundRouting(fallbackOptions) ? fallbackOptions : { maxBand: 'context' },
    refusal: {
      requestedFocusId,
      entityCount: stats.entityCount,
      relationCount: stats.relationCount,
      fallbackFocusId,
    },
  };
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
  /** Recompiles the scan snapshot for a new focus/root (drill-in, restore).
   *  Routed through the anti-hang guard, so no path can compile the whole graph. */
  createScene: (focusEntityId: string, previous?: AtlasScene) => AtlasScene;
  /** Scoped-compile options for a derived (flow/Mermaid) projection of a focus, so
   *  those direct-`buildC4ProjectionBundle` bypass paths stay scoped too. {} below
   *  the gate — identical to an unbounded compile for Okie-sized snapshots. */
  scopeCompileOptions: (focusEntityId: string) => ScanScopedOptions;
  /** The mode-level aspect target applied to every compile (task #30); introspectable
   *  so derived projections and diagnostics can reuse the same deterministic value. */
  targetAspect?: number;
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
export function compileScanFixture(raw: RawScanTrio, options: ScanModeOptions = {}): ScanFixture {
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

  const createScene = (focusEntityId: string, previous?: AtlasScene): AtlasScene => {
    // The guard is the single choke point: it derives the scoped options AND, above
    // the size gate, swaps a would-hang unbounded focus for the safe fallback focus.
    const decision = guardScanCompile(snapshot, focusEntityId, view.rootEntityId);
    const scoped = decision.options;
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: view.rootEntityId,
      focusEntityId: decision.focusEntityId,
      familyId: `view-family:${snapshot.repositoryId}:${decision.focusEntityId}`,
      sceneId: `scan:${snapshot.repositoryId}:c4`,
      title: view.name,
      subtitle: `scanned snapshot · ${snapshot.commitSha.slice(0, 12)}`,
      frozenRevision: snapshot.commitSha,
      previous,
      ...scoped,
      // Aspect target is a per-MODE input applied at every size — deliberately NOT part
      // of `scoped` (which is size-gated), so Okie's below-gate scan still repacks.
      ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
      ...(scoped.maxBand !== undefined ? { bandDepthThreshold: SCAN_BAND_DEPTH_MIN_ENTITIES } : {}),
    });
    return decision.refusal ? { ...scene, scanGuardRefusal: decision.refusal } : scene;
  };

  return {
    snapshot,
    view,
    story,
    createScene,
    scopeCompileOptions: (focusEntityId: string) => scanScopeCompileOptions(snapshot, focusEntityId),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
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
// The ROOT trio (fixtures/scan/{snapshot,view,story}.json) is the Okie self-scan,
// loaded by `?fixture=scan`. PER-REPO trios live one directory deeper
// (fixtures/scan/<slug>/…), loaded by `?fixture=scan:<slug>`; `*` matches a single
// path segment so the two globs never overlap.
type ScanDocGlob = Record<string, () => Promise<{ default: unknown }>>;
const rootScanLoaders: ScanDocGlob = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/{snapshot,view,story}.json');
const repoScanLoaders: ScanDocGlob = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/*/{snapshot,view,story}.json');

/** Sorted slugs of scanned repos present in a per-repo glob map (the loadable set). */
function slugsFromGlob(repo: ScanDocGlob): string[] {
  const slugs = new Set<string>();
  for (const path of Object.keys(repo)) {
    const match = /\/fixtures\/scan\/([^/]+)\/(?:snapshot|view|story)\.json$/.exec(path);
    if (match) slugs.add(match[1]!);
  }
  return [...slugs].sort();
}

/**
 * Sorted slugs of scanned repositories present under fixtures/scan/<slug>/ — derived
 * from what actually built (the ground truth for the fail-closed unknown-slug error),
 * not from the manifest, so a stale index.json can never claim a slug the app cannot load.
 */
export function availableScanRepoSlugs(): string[] {
  return slugsFromGlob(repoScanLoaders);
}

/**
 * Pure resolution of which document loader serves (name, slug) from the root and
 * per-repo glob maps. No slug → the root Okie self-scan; a slug → fixtures/scan/<slug>/,
 * failing closed with a ScanFixtureError that lists the available slugs. Exported so the
 * multi-repo selection + unknown-slug paths are unit-tested with fake maps (no disk).
 */
export function resolveScanDocLoader(
  name: 'snapshot' | 'view' | 'story',
  slug: string | undefined,
  maps: { root: ScanDocGlob; repo: ScanDocGlob },
): () => Promise<{ default: unknown }> {
  if (slug) {
    const key = Object.keys(maps.repo).find(path => path.endsWith(`/fixtures/scan/${slug}/${name}.json`));
    if (!key) {
      const available = slugsFromGlob(maps.repo);
      const message = available.includes(slug)
        ? `Scanned repository “${slug}” is missing ${name}.json — re-run okie-scan for it.`
        : available.length
          ? `No scanned repository “${slug}”. Available: ${available.join(', ')}. Re-run okie-scan --source gh:owner/repo.`
          : `No scanned repository “${slug}”, and none are available. Run okie-scan --source gh:owner/repo to create one.`;
      throw new ScanFixtureError([{ path: name, message }]);
    }
    return maps.repo[key]!;
  }
  const key = Object.keys(maps.root).find(path => path.endsWith(`/${name}.json`));
  if (!key) {
    throw new ScanFixtureError([{
      path: name,
      message: `fixtures/scan/${name}.json was not found — run okie-scan to generate the snapshot trio`,
    }]);
  }
  return maps.root[key]!;
}

async function fetchScanDoc(name: 'snapshot' | 'view' | 'story', slug?: string): Promise<unknown> {
  return (await resolveScanDocLoader(name, slug, { root: rootScanLoaders, repo: repoScanLoaders })()).default;
}

/**
 * Fetches the scanned trio from the gitignored fixtures/scan/ path (served by the
 * dev server, like the stress fixture) and compiles it. `slug` selects a per-repo
 * scan (fixtures/scan/<slug>/); omitted, it loads the root Okie self-scan. The loader
 * is injectable so tests can drive the validate/error path without real files on disk.
 */
export async function loadScanFixture(
  load?: ScanTrioLoader,
  options: ScanModeOptions = {},
  slug?: string,
): Promise<ScanFixture> {
  const loader: ScanTrioLoader = load ?? (name => fetchScanDoc(name, slug));
  const [snapshot, view, story] = await Promise.all([loader('snapshot'), loader('view'), loader('story')]);
  return compileScanFixture({ snapshot, view, story }, options);
}
