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
import { compileC4Scene, compileC4Timeline, type SceneSnapshot, type Timeline } from "@okie/scene-compiler";
import { discoverExtractedTree, discoverRepository, type Discovery, type DiscoverySummary } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment, type EnrichmentReport } from "./enrich.js";
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
  /** container id -> enrichment document (any JSON); accepted docs re-group that scope. */
  enrichmentDocs?: ReadonlyMap<string, unknown>;
}

export interface GithubScanOptions extends ScanOptions {
  /** Transport for GitHub reads (default: anonymous HTTPS + `gh` fallback). Injected in tests. */
  client?: GithubClient;
  /** Cap on the downloaded tarball; a clearer error fires above it. */
  maxTarballBytes?: number;
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

function buildOverviewStory(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  systemId: string,
  repositorySlug: string,
  systemName: string,
): ArchitectureStory {
  return {
    schemaVersion: 1,
    id: typedId("story", repositorySlug, "overview"),
    snapshotId: snapshot.id,
    viewId: view.id,
    title: `${systemName} overview`,
    // One context step on the system root. It cites NO sourceRefs, so it trivially
    // satisfies the host-side evidence-resolution rule (validateStoryDocument).
    steps: [{
      id: "step:overview",
      title: `Start with ${systemName}`,
      focusEntityIds: [systemId],
      reveal: "context",
      narration: `${systemName}, scanned at commit ${snapshot.commitSha.slice(0, 12)}.`,
    }],
  };
}

export interface BuildScanArtifactsParams {
  discovery: Discovery;
  pin: RepositoryPin;
  readFile: (repoRelativePath: string) => string;
  repositorySlug: string;
  systemName: string;
  enrichmentDocs?: ReadonlyMap<string, unknown>;
}

/** Pure pipeline over an already-collected discovery + pin (drives the determinism gate). */
export function buildScanArtifacts(params: BuildScanArtifactsParams): ScanArtifacts {
  const { discovery, pin, readFile, repositorySlug, systemName } = params;
  const systemSlug = slug(systemName);

  const baseExtraction = extractArchitecture({ discovery, readFile, systemName, systemSlug });
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
  const snapshot = adaptArchitectureExtraction(extraction, metadata);
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
  const timeline = compileC4Timeline(snapshot, story, compiled);

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
    const artifacts = buildScanArtifacts({
      discovery,
      pin,
      readFile,
      repositorySlug,
      systemName,
      ...(options.enrichmentDocs ? { enrichmentDocs: options.enrichmentDocs } : {}),
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
