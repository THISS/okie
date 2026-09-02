import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  adaptArchitectureExtraction,
  buildC4ProjectionBundle,
  validateSnapshot,
  validateStory,
  validateView,
  type ArchitectureExtraction,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type ArchitectureExtractionSnapshotMetadata,
  type NodeLayout,
} from "@okie/architecture";
import { compileC4Scene, compileC4Timeline, type CompiledC4Scene, type SceneSnapshot, type Timeline } from "@okie/scene-compiler";
import { attachPathOwners, readCodeOwners } from "./codeowners.js";
import { attachPortableSourceExcerpts } from "./excerpt.js";
import { buildOverviewStory } from "./overview-story.js";
import { discoverExtractedTree, discoverRepository, type Discovery, type DiscoverySummary } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment, type EnrichmentReport } from "./enrich.js";
import { buildEnrichmentPackets, type EmittedPackets } from "./packet.js";
import { pinRepository, type RepositoryPin } from "./pin.js";
import {
  acquireGithubTree,
  createDefaultGithubClient,
  resolveGithubCommit,
  type GithubClient,
  type GithubSourceRef,
} from "./github.js";
import { slug, typedId } from "./ids.js";

export interface ScanOptions {
  systemName?: string;
  repositorySlug?: string;
  /** Scan fixture/example/playground/e2e workspace members too (default: skip them). */
  includeAllMembers?: boolean;
  /** container id -> enrichment document or remainder-packet array; accepted docs merge into that scope. */
  enrichmentDocs?: ReadonlyMap<string, unknown>;
  /** L4 code surface: 'all' (default, every top-level declaration) or 'public' (export surface only). */
  codeSurface?: "all" | "public";
}

export interface GithubScanOptions extends ScanOptions {
  /** Transport for GitHub reads (default: anonymous HTTPS + `gh` fallback). Injected in tests. */
  client?: GithubClient;
  /** Cap on the downloaded tarball; a clearer error fires above it. */
  maxTarballBytes?: number;
  /**
   * Live enrichment adapter (M3): called with the bounded packets while the ephemeral
   * checkout is still on disk; returns container-id-keyed docs to merge through the
   * gate. Remainder packets for one container must be an array (same shape as
   * `--enrich-from`); last-write-wins would drop the first chunk. Used only when no
   * pre-recorded `enrichmentDocs` were supplied. The adapter owns its own resilience
   * — per-scope failures simply omit that scope's doc, and the deterministic base
   * always publishes (an empty map means no enrichment).
   */
  enrichWithPackets?: (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>>;
}

export interface ScanArtifacts {
  pin: RepositoryPin;
  /** The deterministic (pre-enrichment) extraction — the source for enrichment packets. */
  baseExtraction: ArchitectureExtraction;
  extraction: ArchitectureExtraction;
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  story: ArchitectureStory;
  scene: SceneSnapshot;
  timeline: Timeline;
  discoverySummary: DiscoverySummary;
  enrichmentReport?: EnrichmentReport;
}

function rootPackageName(sourceRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(`${sourceRoot}/package.json`, "utf8")) as { name?: string };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** Deterministic legacy grid: the C4 renderer lays out intrinsically, so these
 *  node rects exist ONLY to satisfy validateView and carry story membership. */
function syntheticLayout(snapshot: ArchitectureSnapshot): Record<string, NodeLayout> {
  return Object.fromEntries([...snapshot.entities]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entity, index) => [entity.id, {
      x: 120 + (index % 8) * 330,
      y: 120 + Math.floor(index / 8) * 210,
      width: 280,
      height: 140,
    }]));
}

function buildView(snapshot: ArchitectureSnapshot, systemId: string, repositorySlug: string, systemName: string): ArchitectureView {
  return {
    schemaVersion: 1,
    id: typedId("view", repositorySlug, "hierarchy"),
    snapshotId: snapshot.id,
    name: `${systemName} scan`,
    rootEntityId: systemId,
    entityIds: snapshot.entities.map(entity => entity.id),
    relationIds: snapshot.relations.map(relation => relation.id),
    layout: { nodes: syntheticLayout(snapshot) },
  };
}

/** Keep timeline compilation aligned with the (possibly band-capped) debug scene. */
function storyStepsVisibleInScene(
  compiled: CompiledC4Scene,
  story: ArchitectureStory,
): ArchitectureStory["steps"] {
  const sceneObjectIds = new Set(compiled.scene.objects.map(object => object.id));
  return story.steps.filter(step => {
    const band = step.reveal ?? "context";
    const projection = compiled.projections.projectionById[compiled.projections.family.projectionIds[band]];
    if (!projection) return false;
    const layout = compiled.projections.bandLayoutById[projection.layoutId];
    if (!layout) return false;
    return step.focusEntityIds.some(entityId =>
      (compiled.projections.index.visualNodeIdsByEntityId[entityId] ?? [])
        .some(id => sceneObjectIds.has(id) && layout.nodes[id]));
  });
}

export interface BuildScanArtifactsParams {
  discovery: Discovery;
  pin: RepositoryPin;
  readFile: (repoRelativePath: string) => string;
  repositorySlug: string;
  systemName: string;
  enrichmentDocs?: ReadonlyMap<string, unknown>;
  codeSurface?: "all" | "public";
  /**
   * A base extraction already computed over the SAME inputs (used by the live-enrichment
   * path to avoid extracting twice while the checkout is alive). Must be byte-equal to
   * what extractArchitecture would produce here; callers never mutate it.
   */
  baseExtraction?: ArchitectureExtraction;
}

/** Pure pipeline over an already-collected discovery + pin (drives the determinism gate). */
export function buildScanArtifacts(params: BuildScanArtifactsParams): ScanArtifacts {
  const { discovery, pin, readFile, repositorySlug, systemName } = params;
  const systemSlug = slug(systemName);

  const baseExtraction = params.baseExtraction ?? extractArchitecture({
    discovery,
    readFile,
    systemName,
    systemSlug,
    ...(params.codeSurface ? { codeSurface: params.codeSurface } : {}),
  });
  let extraction = baseExtraction;
  let enrichmentReport: EnrichmentReport | undefined;
  if (params.enrichmentDocs && params.enrichmentDocs.size > 0) {
    const outcome = mergeEnrichment(baseExtraction, params.enrichmentDocs);
    extraction = outcome.extraction;
    enrichmentReport = outcome.report;
  }

  const metadata: ArchitectureExtractionSnapshotMetadata = {
    snapshotId: typedId("snapshot", repositorySlug, pin.commitSha.slice(0, 12)),
    repositoryId: typedId("repo", repositorySlug),
    commitSha: pin.commitSha,
    generatedAt: pin.generatedAt,
  };
  const snapshot = attachPathOwners(
    attachPortableSourceExcerpts(
      adaptArchitectureExtraction(extraction, metadata),
      readFile,
    ),
    readCodeOwners(readFile)?.rules ?? [],
  );
  const snapshotIssues = validateSnapshot(snapshot);
  if (snapshotIssues.length) {
    throw new Error(`Scanned snapshot failed validation:\n${snapshotIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
  }

  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem");
  if (!system) throw new Error("Scanned snapshot has no softwareSystem root");

  const view = buildView(snapshot, system.id, repositorySlug, systemName);
  const viewIssues = validateView(snapshot, view);
  if (viewIssues.length) {
    throw new Error(`Scanned view failed validation:\n${viewIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
  }

  const story = buildOverviewStory(snapshot, view, system.id, repositorySlug, systemName);
  const storyIssues = validateStory(snapshot, view, story);
  if (storyIssues.length) {
    throw new Error(`Scanned story failed validation:\n${storyIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
  }

  // scene.json is a debug artifact — the app compiles per-focus live. A big snapshot's
  // full-graph compile would not terminate (edge routing is superlinear in edges), so
  // above a deterministic relation threshold we bound it to the container-band top scene
  // with an edge budget. Okie (well below the threshold) stays a full, byte-identical scene.
  const SCENE_RELATION_BUDGET = 400;
  const familyId = typedId("view-family", repositorySlug, "system-root");
  const bundle = snapshot.relations.length > SCENE_RELATION_BUDGET
    ? buildC4ProjectionBundle(snapshot, { rootEntityId: system.id, focusEntityId: system.id, familyId, maxBand: "container", maxEdgesPerBand: 64 })
    : buildC4ProjectionBundle(snapshot, { rootEntityId: system.id, focusEntityId: system.id, familyId });
  const compiled = compileC4Scene(snapshot, bundle);
  const visibleSteps = storyStepsVisibleInScene(compiled, story);
  if (!visibleSteps.length) {
    throw new Error("Scanned overview story has no steps visible in the compiled scene");
  }
  const timeline = compileC4Timeline(snapshot, { ...story, steps: visibleSteps }, compiled);

  return {
    pin,
    baseExtraction,
    extraction,
    snapshot,
    view,
    story,
    scene: compiled.scene,
    timeline,
    discoverySummary: discovery.summary,
    ...(enrichmentReport ? { enrichmentReport } : {}),
  };
}

/** Scans a local git working tree at HEAD into the full artifact set. */
export function scanRepository(sourceRoot: string, options: ScanOptions = {}): ScanArtifacts {
  const packageName = rootPackageName(sourceRoot);
  const fallbackName = basename(sourceRoot);
  const repositorySlug = options.repositorySlug ?? slug(packageName ?? fallbackName);
  const systemName = options.systemName ?? packageName ?? (fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1));
  const pin = pinRepository(sourceRoot);
  const discovery = discoverRepository(sourceRoot, options.includeAllMembers ? { includeAllMembers: true } : {});
  return buildScanArtifacts({
    discovery,
    pin,
    readFile: (repoRelativePath: string) => readFileSync(`${sourceRoot}/${repoRelativePath}`, "utf8"),
    repositorySlug,
    systemName,
    ...(options.enrichmentDocs ? { enrichmentDocs: options.enrichmentDocs } : {}),
    ...(options.codeSurface ? { codeSurface: options.codeSurface } : {}),
  });
}

export interface GithubScanResult {
  source: GithubSourceRef;
  commitSha: string;
  artifacts: ScanArtifacts;
}

/**
 * Scans a GitHub repository by `gh:owner/repo[@ref]`: resolves the ref to an immutable
 * commit (SHA + committer date + tree SHA), fetches the codeload tarball at that SHA
 * into a temp dir, walks the extracted tree, and runs the SAME deterministic pipeline
 * as a local scan — then discards the checkout. `generatedAt` is the commit's committer
 * date (never wall-clock), so two scans of the same source at the same SHA are
 * byte-identical. Defaults `repositorySlug`/`systemName` from the repo identity; the
 * extracted `package.json` name refines the display name when present.
 */
export async function scanGithubRepository(source: GithubSourceRef, options: GithubScanOptions = {}): Promise<GithubScanResult> {
  const client = options.client ?? createDefaultGithubClient();
  const commit = await resolveGithubCommit(source, client);
  const acquired = await acquireGithubTree(source, commit.sha, client, options.maxTarballBytes);
  try {
    const readFile = (repoRelativePath: string): string => readFileSync(`${acquired.root}/${repoRelativePath}`, "utf8");
    const packageName = rootPackageName(acquired.root);
    const repositorySlug = options.repositorySlug ?? slug(`${source.owner}-${source.repo}`);
    const systemName = options.systemName ?? packageName ?? source.repo;
    const pin: RepositoryPin = { commitSha: commit.sha, treeHash: commit.treeSha, generatedAt: commit.generatedAt };
    const discovery = discoverExtractedTree(acquired.root, options.includeAllMembers ? { includeAllMembers: true } : {});
    if (discovery.sourceFiles.length === 0) {
      throw new Error(
        `No scannable source files in ${source.owner}/${source.repo} at ${commit.sha.slice(0, 12)}. ` +
        "The scanner extracts .ts/.tsx/.mts/.cts/.mjs/.cjs/.jsx (and .js only for a pure-JS repo); " +
        "this looks like a non-TypeScript/JavaScript repository.",
      );
    }
    // Live enrichment (M3) must run inside this window: packets read source bytes from
    // the ephemeral checkout, which the finally below discards.
    let baseExtraction: ArchitectureExtraction | undefined;
    let enrichmentDocs = options.enrichmentDocs;
    if ((!enrichmentDocs || enrichmentDocs.size === 0) && options.enrichWithPackets) {
      baseExtraction = extractArchitecture({
        discovery,
        readFile,
        systemName,
        systemSlug: slug(systemName),
        ...(options.codeSurface ? { codeSurface: options.codeSurface } : {}),
      });
      const packets = buildEnrichmentPackets(baseExtraction, readFile);
      const generated = await options.enrichWithPackets(packets);
      enrichmentDocs = generated.size > 0 ? generated : undefined;
    }
    const artifacts = buildScanArtifacts({
      discovery,
      pin,
      readFile,
      repositorySlug,
      systemName,
      ...(enrichmentDocs ? { enrichmentDocs } : {}),
      ...(options.codeSurface ? { codeSurface: options.codeSurface } : {}),
      ...(baseExtraction ? { baseExtraction } : {}),
    });
    return { source, commitSha: commit.sha, artifacts };
  } finally {
    acquired.cleanup();
  }
}

/** Canonical, byte-stable JSON serialization (trailing newline, 2-space indent). */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
