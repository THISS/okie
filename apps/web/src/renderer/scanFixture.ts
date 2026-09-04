import {
  assignNeighborhoodSnapshot,
  isNeighborhoodPacket,
  mergeChildCounts,
  validateNeighborhoodPacket,
  validateSnapshot,
  validateStoryDocument,
  validateView,
  type ArchitectureNeighborhoodPacket,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type C4Band,
  type EntityKind,
  type SourceExcerpt,
  type ValidationIssue,
} from '@okie/architecture';
import { compileAppStoryPlan, createC4Scene, type AppStoryPlan } from './goldenC4Scene';
import { rememberPublishedChildCounts } from './lazyBandCompile';
import type { AtlasScene, ScanGuardRefusal } from './types';

// Hang-guard only (CLA-66 / CLA-67): unbounded full-graph compiles above this
// entity count are refused. Band scoping is the DEFAULT scan path at every
// size — do not raise this number as a product fix, and do not treat a bigger
// dump as the slice. CLA-67 measured the per-band curve in
// docs/architecture/band-cost-curve.md; the hang-guard stays 2000 until a
// replacement is taken from that table (tests lock the number).
export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;
export const SCAN_CONTAINER_EDGE_BUDGET = 24;     // routed edges per band at a container drill-in
export const SCAN_CONTAINER_GRID_NODES = 1500;    // router grid-node cap at a container drill-in

// Relation-pressure gate: the symbol-level `uses` graph makes edge ROUTING the
// dominant cost even when the entity count sits far under the hang-guard
// (okie's own public scan: 850 entities but ~1.7k relations → a two-minute
// unbounded compile). Above this relation count every compile takes an edge
// budget; dropped edges stay enumerable via omittedEdgeIds ("+N more").
// Per-kind maxBand still applies (current band + one-down prefetch) — the
// relation gate never compiles the whole tree.
export const SCAN_RELATION_EDGE_MIN = 600;   // relation gate — above this, budget the routed edges
export const SCAN_RELATION_EDGE_BUDGET = 64; // routed edges per band under the relation gate

export type ScanScopedOptions = { maxBand?: C4Band; maxEdgesPerBand?: number; maxGridNodes?: number };

/**
 * Mode-level compile options for scan mode (task #30). Independent of per-kind
 * maxBand: they apply to every scan compile at any repo size, because the
 * tall-container problem (a system packing into one narrow column) shows up on
 * small scans too (e.g. Okie's own scan). `targetAspect` is chosen once by the
 * client at bootstrap (device orientation) and is a deterministic compile input,
 * never the live viewport.
 */
export type ScanModeOptions = { targetAspect?: number };

// Per-focus-kind scoped options — the default scan compile path (CLA-66).
// Current C4 band + one band down: system→container; container→component;
// component→code. Open inside / zoom-target compile uses this mapping, not
// a panic at SCAN_BAND_DEPTH_MIN_ENTITIES.
const SCAN_SCOPED_OPTIONS_BY_KIND: Partial<Record<EntityKind, ScanScopedOptions>> = {
  person: { maxBand: 'container' },
  softwareSystem: { maxBand: 'container' },
  externalSystem: { maxBand: 'container' },
  boundary: { maxBand: 'container' },
  container: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES },
  dataStore: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES },
  queue: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES },
  component: { maxBand: 'code' },
  // code focus → {} (deepest bands already route; hang-guard still applies)
};

/**
 * Deterministic scoped-compile options for a scan-mode focus. Band scoping is
 * the default path at every repo size (CLA-66): system→container band;
 * container drill-in→component band + edge budget + router grid cap;
 * component→code band. A second, independent relation gate
 * (> SCAN_RELATION_EDGE_MIN) adds a per-band routed-edge budget plus a router
 * grid cap wherever the options don't already carry one. SCAN_BAND_DEPTH_MIN_ENTITIES
 * is not a compile-strategy switch — it remains the hang-guard in
 * {@link guardScanCompile} only.
 */
export function scanScopeCompileOptions(snapshot: ArchitectureSnapshot, focusEntityId: string): ScanScopedOptions {
  const aboveRelationGate = snapshot.relations.length > SCAN_RELATION_EDGE_MIN;
  const focus = snapshot.entities.find(entity => entity.id === focusEntityId);
  const scoped = focus ? SCAN_SCOPED_OPTIONS_BY_KIND[focus.kind] : undefined;
  const options: ScanScopedOptions = scoped ? { ...scoped } : {};
  if (aboveRelationGate) {
    options.maxEdgesPerBand ??= SCAN_RELATION_EDGE_BUDGET;
    options.maxGridNodes ??= SCAN_CONTAINER_GRID_NODES;
  }
  return options;
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
 * scan compiles pass through. Derives scoped options for the requested focus
 * (per-kind maxBand at every size — CLA-66) and, ABOVE the hang-guard entity
 * count, refuses any focus whose scope exceeds that count when no option bounds
 * the routing (an unbounded full-graph compile — the deep-link hang vector).
 * On refusal it substitutes the scoped fallback focus (the view root), forcing a
 * guaranteed-bounded band if even the fallback derives no constraint, so the app
 * renders a safe scene instead of freezing.
 *
 * Below the hang-guard the refusal walk is skipped; per-kind maxBand still
 * applies so Open inside is the default scoped path, not a panic at 2000.
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
   *  those direct-`buildC4ProjectionBundle` bypass paths stay scoped too. */
  scopeCompileOptions: (focusEntityId: string) => ScanScopedOptions;
  /** The mode-level aspect target applied to every compile (task #30); introspectable
   *  so derived projections and diagnostics can reuse the same deterministic value. */
  targetAspect?: number;
  navigation: ScanNavigationDefaults;
  /** Published child counts, including descendants not yet fetched (CLA-73). */
  childCounts: Record<string, number>;
  /** How the snapshot arrived — neighborhood fetch vs the full published trio. */
  boot: 'neighborhood' | 'full';
  /** Fetch+merge a container/file subgraph. No-op when the neighborhood is already resident. */
  ensureNeighborhood: (focusEntityId: string) => Promise<void>;
  /** Fetch portable excerpts for one entity when Source opens. */
  ensureExcerpts: (entityId: string) => Promise<SourceExcerpt[] | undefined>;
};

export type RawScanTrio = { snapshot: unknown; view: unknown; story: unknown };
export type ScanTrioLoader = (name: 'snapshot' | 'view' | 'story') => Promise<unknown>;
export type ScanNeighborhoodHost = {
  loadNeighborhood: (focusEntityId: string) => Promise<ArchitectureNeighborhoodPacket>;
  loadExcerpts: (entityId: string) => Promise<SourceExcerpt[] | undefined>;
  loadStory: () => Promise<unknown>;
};

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

function childCountsFromSnapshot(snapshot: ArchitectureSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of snapshot.entities) counts[entity.id] = 0;
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    counts[entity.parentId] = (counts[entity.parentId] ?? 0) + 1;
  }
  return counts;
}

function buildLiveScanFixture(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  story: AppStoryPlan,
  options: ScanModeOptions,
  extras: {
    boot: ScanFixture['boot'];
    childCounts: Record<string, number>;
    host?: ScanNeighborhoodHost;
    loadedFocusIds?: Set<string>;
  },
): ScanFixture {
  const childCounts = extras.childCounts;
  rememberPublishedChildCounts(snapshot, childCounts);
  const loadedFocusIds = extras.loadedFocusIds ?? new Set<string>();
  const inflight = new Map<string, Promise<void>>();
  const host = extras.host;

  const createScene = (focusEntityId: string, previous?: AtlasScene): AtlasScene => {
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
      ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
      ...(scoped.maxBand !== undefined ? { bandDepthThreshold: SCAN_BAND_DEPTH_MIN_ENTITIES } : {}),
    });
    return decision.refusal ? { ...scene, scanGuardRefusal: decision.refusal } : scene;
  };

  const ensureNeighborhood = async (focusEntityId: string): Promise<void> => {
    if (!host) return;
    const focus = focusEntityId.trim();
    if (!focus) return;
    if (loadedFocusIds.has(focus)) return;
    const resident = snapshot.entities.some(entity => entity.id === focus);
    const knownChildren = snapshot.entities.some(entity => entity.parentId === focus);
    const publishedChildren = childCounts[focus] ?? 0;
    // Resident leaves and already-expanded boxes skip the network. A deep-link
    // or tour focus that is not in the slim snapshot must still fetch — L1
    // childCounts does not list omitted L4 ids.
    if (resident && (knownChildren || publishedChildren === 0)) {
      loadedFocusIds.add(focus);
      return;
    }
    const pending = inflight.get(focus);
    if (pending) {
      await pending;
      return;
    }
    const work = (async () => {
      const packet = await host.loadNeighborhood(focus);
      const packetIssues = validateNeighborhoodPacket(packet);
      if (packetIssues.length) throw new ScanFixtureError(packetIssues);
      assignNeighborhoodSnapshot(snapshot, packet.snapshot);
      for (const id of packet.view.entityIds) {
        if (!view.entityIds.includes(id)) view.entityIds.push(id);
      }
      for (const id of packet.view.relationIds) {
        if (!view.relationIds.includes(id)) view.relationIds.push(id);
      }
      Object.assign(view.layout.nodes, packet.view.layout.nodes);
      if (packet.view.layout.edges) {
        view.layout.edges = { ...(view.layout.edges ?? {}), ...packet.view.layout.edges };
      }
      Object.assign(childCounts, mergeChildCounts(childCounts, packet.childCounts));
      loadedFocusIds.add(focus);
      loadedFocusIds.add(packet.focusEntityId);
    })();
    inflight.set(focus, work);
    try {
      await work;
    } finally {
      inflight.delete(focus);
    }
  };

  const ensureExcerpts = async (entityId: string): Promise<SourceExcerpt[] | undefined> => {
    const existing = snapshot.entities.find(entity => entity.id === entityId);
    if (existing?.sourceExcerpts?.length) return existing.sourceExcerpts;
    if (!host) return existing?.sourceExcerpts;
    const excerpts = await host.loadExcerpts(entityId);
    if (excerpts?.length && existing) existing.sourceExcerpts = excerpts;
    return excerpts;
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
    childCounts,
    boot: extras.boot,
    ensureNeighborhood,
    ensureExcerpts,
  };
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

  return buildLiveScanFixture(snapshot, view, story, options, {
    boot: 'full',
    childCounts: childCountsFromSnapshot(snapshot),
  });
}

export function compileScanNeighborhoodFixture(
  packet: ArchitectureNeighborhoodPacket,
  rawStory: unknown,
  host: ScanNeighborhoodHost,
  options: ScanModeOptions = {},
): ScanFixture {
  const packetIssues = validateNeighborhoodPacket(packet);
  if (packetIssues.length) throw new ScanFixtureError(packetIssues);
  if (!isRecord(rawStory)) throw new ScanFixtureError([{ path: 'story', message: 'must be a JSON object' }]);
  let story: AppStoryPlan;
  try {
    story = compileAppStoryPlan(packet.snapshot, packet.view, rawStory as ArchitectureStory, { allowMissingFocus: true });
  } catch (error) {
    throw new ScanFixtureError([{ path: 'story', message: error instanceof Error ? error.message : String(error) }]);
  }
  return buildLiveScanFixture(packet.snapshot, packet.view, story, options, {
    boot: 'neighborhood',
    childCounts: { ...packet.childCounts },
    host,
    loadedFocusIds: new Set([packet.focusEntityId]),
  });
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
 * Runtime-fetch trio loader (embed-hosting §1's "one required app change"): reads
 * /scan/<slug>/{snapshot,view,story}.json from the serving origin — objects a scan
 * worker published AFTER this bundle was built, which the build-time glob can never
 * see. In dev the vite proxy forwards /scan/* to the scan server; hosted, the same
 * paths come from object storage behind the CDN. Fails closed like the glob path:
 * a missing or invalid object raises ScanFixtureError, never a partial fixture.
 */
export function fetchScanTrioLoader(slug?: string, fetchImpl: typeof fetch = fetch): ScanTrioLoader {
  return async name => {
    const path = slug
      ? `/scan/${encodeURIComponent(slug)}/${name}.json`
      : `/scan/${name}.json`;
    let response: Response;
    try {
      response = await fetchImpl(path);
    } catch (error) {
      throw new ScanFixtureError([{
        path: name,
        message: `Could not reach the scan service for ${path} (${error instanceof Error ? error.message : String(error)}).`,
      }]);
    }
    if (!response.ok) {
      throw new ScanFixtureError([{
        path: name,
        message: response.status === 404
          ? `No scanned repository is published at ${path}. Paste the repository on the scan page to create it.`
          : `Failed to load ${path} (HTTP ${response.status}).`,
      }]);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new ScanFixtureError([{ path: name, message: `${path} is not valid JSON.` }]);
    }
  };
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

function scanObjectPath(slug: string | undefined, basename: string, query?: string): string {
  const path = slug
    ? `/scan/${encodeURIComponent(slug)}/${basename}`
    : `/scan/${basename}`;
  return query ? `${path}?${query}` : path;
}

async function fetchScanJson(path: string, fetchImpl: typeof fetch, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(path);
  } catch (error) {
    throw new ScanFixtureError([{
      path: label,
      message: `Could not reach the scan service for ${path} (${error instanceof Error ? error.message : String(error)}).`,
    }]);
  }
  if (!response.ok) {
    throw new ScanFixtureError([{
      path: label,
      message: response.status === 404
        ? `No scanned repository is published at ${path}. Paste the repository on the scan page to create it.`
        : `Failed to load ${path} (HTTP ${response.status}).`,
    }]);
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new ScanFixtureError([{ path: label, message: `${path} is not valid JSON.` }]);
  }
}

/** Deep-link / Open-inside focus from the share URL. `sel` wins over lens/root. */
export function bootFocusFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const sel = params.get('sel')?.trim();
  if (sel) return sel;
  const lens = params.getAll('lens').map(id => id.trim()).filter(Boolean);
  const deepest = lens.at(-1);
  if (deepest) return deepest;
  const root = params.get('root')?.trim();
  return root || undefined;
}

/**
 * Runtime-fetch neighborhood host (CLA-73): `/scan/<slug>/neighborhood.json`
 * plus lazy `/excerpt.json` and `story.json`. Does not GET snapshot.json/view.json.
 */
export function fetchScanNeighborhoodHost(slug?: string, fetchImpl: typeof fetch = fetch): ScanNeighborhoodHost {
  return {
    async loadNeighborhood(focusEntityId: string) {
      const focus = focusEntityId.trim();
      const query = focus ? new URLSearchParams({ focus }).toString() : undefined;
      const raw = await fetchScanJson(scanObjectPath(slug, 'neighborhood.json', query), fetchImpl, 'neighborhood');
      if (!isNeighborhoodPacket(raw)) {
        throw new ScanFixtureError([{ path: 'neighborhood', message: 'Scan neighborhood packet is structurally invalid.' }]);
      }
      return raw;
    },
    async loadExcerpts(entityId: string) {
      const query = new URLSearchParams({ entity: entityId });
      const raw = await fetchScanJson(scanObjectPath(slug, 'excerpt.json', query.toString()), fetchImpl, 'excerpt');
      if (!isRecord(raw) || raw.kind !== 'excerpt' || !Array.isArray(raw.sourceExcerpts)) {
        throw new ScanFixtureError([{ path: 'excerpt', message: 'Scan excerpt packet is structurally invalid.' }]);
      }
      return raw.sourceExcerpts as SourceExcerpt[];
    },
    loadStory: () => fetchScanJson(scanObjectPath(slug, 'story.json'), fetchImpl, 'story'),
  };
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

export async function loadScanNeighborhoodFixture(
  host: ScanNeighborhoodHost,
  focusEntityId: string | undefined,
  options: ScanModeOptions = {},
): Promise<ScanFixture> {
  const [packet, story] = await Promise.all([
    host.loadNeighborhood(focusEntityId ?? ''),
    host.loadStory(),
  ]);
  return compileScanNeighborhoodFixture(packet, story, host, options);
}
