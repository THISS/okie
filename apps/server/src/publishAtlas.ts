import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { ArchitectureSnapshot, ArchitectureView } from "@okie/architecture";
import { parseGithubSource } from "@okie/scan";
import type { OperatorArtifactRevision, OperatorPublication } from "./operatorContracts.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { canonicalOperatorRepositoryId, type OperatorStore, type OperatorStoreState } from "./operatorStore.js";
import { readArtifactScopes } from "./operatorWorkflow.js";
import {
  isPublishedSlug,
  isPublishedVersionId,
  PRIVATE_SCAN_FILES,
  PUBLIC_SCAN_FILES,
  PUBLISHED_INDEX_SCHEMA,
  PUBLISHED_LATEST_SCHEMA,
  PUBLISHED_PACK_INDEX_SCHEMA,
  PUBLISHED_SOURCE_PATHS_SCHEMA,
  PUBLISHED_VERSION_SCHEMA,
  isStructureCardRendererVersion,
  publishedCardKey,
  publishedIndexKey,
  publishedLatestKey,
  publishedManifestKey,
  publishedPackIndexKey,
  publishedPackKey,
  publishedPrivateFileKey,
  publishedPublicFileKey,
  publishedSourcePathsKey,
  type PublishedFileEntry,
  type PublishedIndex,
  type PublishedIndexEntry,
  type PublishedLatestPointer,
  type PublishedLicense,
  type PublishedPackEncoding,
  type PublishedPackIndex,
  type PublishedPackName,
  type PublishedSourcePaths,
  type PublishedVersionManifest,
} from "./publishedStoreLayout.js";
import { excerptPacketFor, neighborhoodPacketFor, sanitizeFocusId } from "./scanNeighborhood.js";
import { validSourcePath } from "./scanSource.js";

/**
 * CLA-266 operator publish step: builds one immutable published version of a repository's CURRENT operator
 * publication (read-only over the operator store: no owner lock, no writes) and uploads it in the layout of
 * publishedStoreLayout.ts — files and packs, then manifest.json, then latest.json, then index.json.
 */

export type PublishEnv = "staging" | "production" | "local";

/** The only place bucket names live. */
export const PUBLISH_BUCKETS: Readonly<Record<PublishEnv, string>> = {
  staging: "sourcefor-atlas-staging",
  production: "sourcefor-atlas",
  local: "sourcefor-atlas-local",
};

export function isPublishEnv(value: string | undefined): value is PublishEnv {
  return value === "staging" || value === "production" || value === "local";
}

export interface PublishObject { key: string; bytes: Buffer; contentType: string }

export interface BuiltPublishedVersion {
  slug: string;
  versionId: string;
  manifest: PublishedVersionManifest;
  manifestBytes: Buffer;
  latestBytes: Buffer;
  indexEntry: PublishedIndexEntry;
  /** CLA-318: GitHub's casing lookup (what landed in the index row, or why nothing did); set by preparePublishedVersion. */
  githubNames?: GithubNamesLookup;
  /** Immutable version objects (public/, private/, packs/, the card), manifest excluded: it is written after all of them. */
  objects: PublishObject[];
  /**
   * CLA-319: the share card (also in `objects`), or why there is none (no renderer given, or it failed: the publish
   * goes ahead without a card and `/og` serves the generated one). Not in the manifest (see publishedStoreLayout.ts).
   */
  card?: PublishObject | { error: string };
  stats: {
    buildMs: number;
    packMs: number;
    neighborhoodEntries: number;
    excerptEntries: number;
    /** Uncompressed route bytes across all entries, and the stored (gzip) pack sizes. */
    neighborhoodRawBytes: number;
    neighborhoodPackBytes: number;
    excerptRawBytes: number;
    excerptPackBytes: number;
  };
}

const JSON_TYPE = "application/json";
const PNG_TYPE = "image/png";

/**
 * CLA-319: the publish-time structure card renderer. apps/server cannot import apps/web, so scripts/publish-atlas.mjs
 * bundles apps/web/src/atlasStructureCard.ts and injects its `renderAtlasStructureCardPng` and
 * `STRUCTURE_CARD_RENDERER_VERSION` here. `render` is pure (same input, same pixels) and may throw.
 */
export interface StructureCardRenderer {
  version: string;
  render: (input: { snapshot: ArchitectureSnapshot; view: ArchitectureView; label: { owner: string; repo: string } }) => Uint8Array;
}

export const STRUCTURE_CARD_WIDTH = 1200;
export const STRUCTURE_CARD_HEIGHT = 630;

/** True for PNG bytes whose IHDR says 1200×630 (what `/og` will serve). */
export function isStructureCardPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, i) => bytes[i] !== value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) === STRUCTURE_CARD_WIDTH && view.getUint32(20) === STRUCTURE_CARD_HEIGHT;
}

/**
 * Renders one card; never throws. Anything off (a bad renderer version, a render that throws, bytes that are not a
 * 1200×630 PNG) is `{ error }`, and the caller publishes without a card.
 */
export function renderStructureCardObject(renderer: StructureCardRenderer, input: { slug: string; versionId: string; snapshot: ArchitectureSnapshot; view: ArchitectureView; label: { owner: string; repo: string } }): PublishObject | { error: string } {
  try {
    if (!isStructureCardRendererVersion(renderer.version)) return { error: `invalid structure card renderer version ${JSON.stringify(renderer.version)}` };
    const png = renderer.render({ snapshot: input.snapshot, view: input.view, label: input.label });
    if (!isStructureCardPng(png)) return { error: "the structure card renderer did not return a 1200×630 PNG" };
    return { key: publishedCardKey(input.slug, input.versionId, renderer.version), bytes: Buffer.from(png), contentType: PNG_TYPE };
  } catch (cause) {
    return { error: `the structure card could not be rendered (${cause instanceof Error ? cause.message : String(cause)})` };
  }
}
const PACK_TYPE = "application/octet-stream";
/**
 * One pack object must stay under wrangler's 315 MB per-object `r2 object put` limit. thiss/okie (4,048 entities) is
 * 31 MB compressed, so a single object per pack has an order of magnitude of headroom; above this the publish fails
 * loudly instead of sharding.
 */
export const MAX_PACK_BYTES = 300 * 1024 * 1024;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const entryFor = (bytes: Buffer): PublishedFileEntry => ({ bytes: bytes.byteLength, sha256: sha256(bytes) });
/** Exactly what `sendJson(..., pretty = false)` writes. */
export const compactJsonBody = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);

/**
 * One complete gzip member (RFC 1952) of `bytes`. The header's MTIME is 0 (zlib's default) and its OS byte is forced to
 * 255 ("unknown"), so the same input yields the same pack bytes on every platform and an identical re-publish stays
 * byte-identical (the version manifest records each pack's sha256).
 */
export function gzipMember(bytes: Buffer): Buffer {
  const member = gzipSync(bytes, { level: 6 });
  member[9] = 0xff;
  return member;
}

/**
 * Read-only view of an operator-v1 store: parses state.json and reads artifact files directly. Never constructs
 * `OperatorStore` (its constructor takes the owner lock and may rewrite state.json).
 */
export class ReadonlyOperatorStore {
  readonly root: string;
  constructor(scanRoot: string) {
    this.root = resolve(scanRoot, "operator-v1");
    if (!existsSync(join(this.root, "state.json"))) throw new Error(`no operator store at ${this.root}`);
  }
  snapshot(): Readonly<OperatorStoreState> {
    const state = JSON.parse(readFileSync(join(this.root, "state.json"), "utf8")) as Partial<OperatorStoreState>;
    return { runs: [], drafts: [], attempts: [], explanations: [], events: [], artifacts: [], publications: [], ...state };
  }
  artifactFilePath(artifactRevisionId: string, fileName: string): string | undefined {
    if (basename(fileName) !== fileName) return undefined;
    const path = resolve(this.root, "artifacts", artifactRevisionId, fileName);
    return path.startsWith(join(this.root, "artifacts") + sep) && existsSync(path) ? path : undefined;
  }
  readArtifactFile(artifactRevisionId: string, fileName: string): Buffer | undefined {
    const path = this.artifactFilePath(artifactRevisionId, fileName);
    return path ? readFileSync(path) : undefined;
  }
  /** The read methods the publication service and readArtifactScopes use; they never write through it. */
  asOperatorStore(): OperatorStore { return this as unknown as OperatorStore; }
}

/** `owner/name` → the operator's canonical repository id. */
export function operatorRepositoryIdForRepo(repo: string): string {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repo.trim());
  if (!match) throw new Error("--repo must be owner/name");
  return canonicalOperatorRepositoryId(`repo:${match[1]}/${match[2]}`);
}

/** The repository's CURRENT publication (pointer) and its artifact, read-only. */
export function currentPublicationForRepo(store: ReadonlyOperatorStore, repositoryId: string): { publication: OperatorPublication; artifact: OperatorArtifactRevision; slug: string; owner: string; repo: string } {
  // OperatorPublicationService only reads through the store here; its constructor's mkdir is a no-op once current/ exists.
  if (!existsSync(join(store.root, "current"))) throw new Error("the operator store has no publications");
  const publications = new OperatorPublicationService(store.asOperatorStore());
  const publication = publications.currentPublication(repositoryId);
  if (!publication) throw new Error(`no current publication for ${repositoryId}`);
  const state = store.snapshot();
  const artifact = state.artifacts.find(value => value.artifactRevisionId === publication.artifactRevisionId);
  if (!artifact) throw new Error("the current publication's artifact is missing");
  const run = [...state.runs]
    .filter(value => canonicalOperatorRepositoryId(value.source.repositoryId) === repositoryId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!run) throw new Error("no operator run names this repository");
  return { publication, artifact, slug: run.source.slug, owner: run.source.owner, repo: run.source.repo };
}

function pack(name: PublishedPackName, slug: string, versionId: string, entries: Array<[string, Buffer]>, encoding: PublishedPackEncoding, maxBytes: number): { objects: PublishObject[]; entry: PublishedFileEntry & { entries: number; encoding: PublishedPackEncoding } } {
  const index: PublishedPackIndex = { schema: PUBLISHED_PACK_INDEX_SCHEMA, encoding, entries: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [key, bytes] of entries) {
    index.entries[key] = [offset, bytes.byteLength];
    chunks.push(bytes);
    offset += bytes.byteLength;
  }
  if (offset > maxBytes) {
    throw new Error(`the ${name} pack is ${offset} bytes, over the ${maxBytes}-byte single-object limit (wrangler puts at most 315 MB per object); refusing to publish — the pack needs sharding`);
  }
  const packBytes = Buffer.concat(chunks, offset);
  return {
    objects: [
      { key: publishedPackKey(slug, versionId, name), bytes: packBytes, contentType: PACK_TYPE },
      { key: publishedPackIndexKey(slug, versionId, name), bytes: compactJsonBody(index), contentType: JSON_TYPE },
    ],
    entry: { ...entryFor(packBytes), entries: entries.length, encoding },
  };
}

/** Pack entries: each one is its own gzip member of the exact route body, so a range read is a complete gzip stream. */
export interface PacketPackEntries {
  neighborhood: Array<[string, Buffer]>;
  excerpt: Array<[string, Buffer]>;
  rawBytes: { neighborhood: number; excerpt: number };
}

/**
 * Precomputed packets, byte-identical to the routes once inflated: `neighborhood` for the default focus ("") and EVERY
 * entity the route's focus check accepts verbatim (`sanitizeFocusId(id) === id`), leaves included, so normal browsing
 * never needs the container; `excerpt` for every such entity that has one. Only the gzip member of each body is kept
 * in memory (thiss/okie: 394 MB of route bodies → 31 MB).
 */
export function buildPacketPacks(snapshot: ArchitectureSnapshot, view: ArchitectureView, publication: { versionId: string; artifactRevisionId: string }): PacketPackEntries {
  const ids = [...new Set(snapshot.entities.map(entity => entity.id))].filter(id => sanitizeFocusId(id) === id).sort();
  const rawBytes = { neighborhood: 0, excerpt: 0 };
  const member = (kind: keyof typeof rawBytes, body: Buffer): Buffer => { rawBytes[kind] += body.byteLength; return gzipMember(body); };
  const neighborhood: Array<[string, Buffer]> = [["", member("neighborhood", compactJsonBody(neighborhoodPacketFor(snapshot, view, { focus: null, publication })))]];
  for (const id of ids) neighborhood.push([id, member("neighborhood", compactJsonBody(neighborhoodPacketFor(snapshot, view, { focus: id, publication })))]);
  const excerpt: Array<[string, Buffer]> = [];
  for (const id of ids) {
    const packet = excerptPacketFor(snapshot, id);
    if (packet) excerpt.push([id, member("excerpt", compactJsonBody(packet))]);
  }
  return { neighborhood, excerpt, rawBytes };
}

/**
 * The pinned source view's allowlist: every repository-relative path some entity's sourceRefs records at the snapshot
 * commit that `validSourcePath` accepts — the same check scanSource.ts applies before fetching a file.
 */
export function publishedSourcePathsFor(snapshot: ArchitectureSnapshot, owner: string, repo: string): PublishedSourcePaths {
  const commitSha = snapshot.commitSha;
  const paths = new Set<string>();
  for (const entity of snapshot.entities) {
    for (const ref of entity.sourceRefs ?? []) if (ref.commitSha === commitSha && typeof ref.path === "string" && validSourcePath(ref.path)) paths.add(ref.path);
  }
  return { schema: PUBLISHED_SOURCE_PATHS_SCHEMA, owner, repo, commitSha, paths: [...paths].sort() };
}

/** The index.json row for a version, from its manifest alone (publish and `--set-latest` share it). */
export function publishedIndexEntryFor(manifest: PublishedVersionManifest): PublishedIndexEntry {
  return {
    slug: manifest.slug,
    owner: manifest.owner,
    repo: manifest.repo,
    // The scan ScanManifest reader's repositoryId is the snapshot's (e.g. `repo:thiss-okie`), not the operator key.
    repositoryId: manifest.snapshotRepositoryId,
    versionId: manifest.versionId,
    commitSha: manifest.commitSha,
    generatedAt: manifest.generatedAt,
    entityCount: manifest.entityCount,
    publishedAt: manifest.publishedAt,
    license: manifest.license,
  };
}

/** latest.json bytes for a version (its publication time, so a `--set-latest` back to it writes the same pointer). */
export function publishedLatestBytes(slug: string, versionId: string, publishedAt: string): Buffer {
  const latest: PublishedLatestPointer = { schema: PUBLISHED_LATEST_SCHEMA, slug, versionId, publishedAt };
  return Buffer.from(`${JSON.stringify(latest, null, 2)}\n`);
}

/** Owner, repo and commit of the repository's current publication (what the licence lookup needs), read-only. */
export function currentPublicationSource(input: { scanRoot: string; repo: string }): { owner: string; repo: string; commitSha: string } {
  const store = new ReadonlyOperatorStore(input.scanRoot);
  const { artifact, owner, repo } = currentPublicationForRepo(store, operatorRepositoryIdForRepo(input.repo));
  let commitSha = artifact.sourceCommitSha;
  if (!commitSha) {
    const bytes = store.readArtifactFile(artifact.artifactRevisionId, "snapshot.json");
    if (!bytes) throw new Error("artifact file snapshot.json is missing");
    commitSha = (JSON.parse(bytes.toString("utf8")) as ArchitectureSnapshot).commitSha;
  }
  return { owner, repo, commitSha };
}

export function buildPublishedVersion(input: { scanRoot: string; repo: string; license: PublishedLicense; names?: GithubRepositoryInfo; now?: () => number; maxPackBytes?: number; structureCard?: StructureCardRenderer; log?: (line: string) => void }): BuiltPublishedVersion {
  const now = input.now ?? (() => performance.now());
  const started = now();
  const store = new ReadonlyOperatorStore(input.scanRoot);
  const repositoryId = operatorRepositoryIdForRepo(input.repo);
  const { publication, artifact, slug, owner, repo } = currentPublicationForRepo(store, repositoryId);
  if (!isPublishedSlug(slug)) throw new Error(`slug ${JSON.stringify(slug)} is not a valid published slug`);
  if (!isPublishedVersionId(publication.versionId)) throw new Error("publication version id is not a valid published version id");
  const { versionId, artifactRevisionId } = publication;
  const read = (name: string): Buffer => {
    const bytes = store.readArtifactFile(artifactRevisionId, name);
    if (!bytes) throw new Error(`artifact file ${name} is missing`);
    return bytes;
  };
  const objects: PublishObject[] = [];
  const publicEntries: Record<string, PublishedFileEntry> = {};
  const privateEntries: Record<string, PublishedFileEntry> = {};
  for (const name of [...artifact.files].sort()) {
    if (!PUBLIC_SCAN_FILES.includes(name)) continue;
    // The public sidecar is the claim-stripped form the server serves; the raw artifact bytes stay private.
    const bytes = name === "operator-explanations.json"
      ? compactJsonBody({ versionId, explanations: readArtifactScopes(store.asOperatorStore(), artifactRevisionId) })
      : read(name);
    publicEntries[name] = entryFor(bytes);
    objects.push({ key: publishedPublicFileKey(slug, versionId, name), bytes, contentType: JSON_TYPE });
  }
  for (const name of [...artifact.files].sort()) {
    if (!PRIVATE_SCAN_FILES.includes(name)) continue;
    const bytes = read(name);
    privateEntries[name] = entryFor(bytes);
    objects.push({ key: publishedPrivateFileKey(slug, versionId, name), bytes, contentType: JSON_TYPE });
  }
  if (!publicEntries["snapshot.json"] || !publicEntries["view.json"]) throw new Error("the publication has no snapshot.json / view.json");
  const snapshot = JSON.parse(read("snapshot.json").toString("utf8")) as ArchitectureSnapshot;
  const view = JSON.parse(read("view.json").toString("utf8")) as ArchitectureView;

  const packStarted = now();
  const packets = buildPacketPacks(snapshot, view, { versionId, artifactRevisionId });
  const neighborhood = pack("neighborhood", slug, versionId, packets.neighborhood, "gzip", input.maxPackBytes ?? MAX_PACK_BYTES);
  const excerpt = pack("excerpt", slug, versionId, packets.excerpt, "gzip", input.maxPackBytes ?? MAX_PACK_BYTES);
  const packMs = now() - packStarted;
  objects.push(...neighborhood.objects, ...excerpt.objects);
  const sourcePathsBytes = compactJsonBody(publishedSourcePathsFor(snapshot, owner, repo));
  objects.push({ key: publishedSourcePathsKey(slug, versionId), bytes: sourcePathsBytes, contentType: JSON_TYPE });
  // CLA-319: the share card, printed with GitHub's casing when the lookup found it. A failure never fails the publish.
  let card: BuiltPublishedVersion["card"];
  if (input.structureCard) {
    card = renderStructureCardObject(input.structureCard, { slug, versionId, snapshot, view, label: input.names ? { owner: input.names.ownerLogin, repo: input.names.repoName } : { owner, repo } });
    if ("error" in card) input.log?.(`WARNING: publishing without a share card: ${card.error}; /og serves the generated card`);
    else objects.push(card);
  }

  const commitSha = artifact.sourceCommitSha ?? snapshot.commitSha;
  const publishedAt = new Date(publication.createdAt).toISOString();
  const manifest: PublishedVersionManifest = {
    schema: PUBLISHED_VERSION_SCHEMA,
    slug,
    owner,
    repo,
    repositoryId,
    versionId,
    artifactRevisionId,
    commitSha,
    publishedAt,
    ...(publication.previousVersionId ? { previousVersionId: publication.previousVersionId } : {}),
    entityCount: snapshot.entities.length,
    snapshotRepositoryId: snapshot.repositoryId,
    generatedAt: typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : publishedAt,
    license: input.license,
    public: publicEntries,
    private: privateEntries,
    packs: { neighborhood: neighborhood.entry, excerpt: excerpt.entry },
    sourcePaths: entryFor(sourcePathsBytes),
  };
  return {
    slug,
    versionId,
    manifest,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    latestBytes: publishedLatestBytes(slug, versionId, publishedAt),
    indexEntry: withGithubNames(publishedIndexEntryFor(manifest), input.names),
    objects,
    ...(card ? { card } : {}),
    stats: {
      buildMs: now() - started,
      packMs,
      neighborhoodEntries: packets.neighborhood.length,
      excerptEntries: packets.excerpt.length,
      neighborhoodRawBytes: packets.rawBytes.neighborhood,
      neighborhoodPackBytes: neighborhood.entry.bytes,
      excerptRawBytes: packets.rawBytes.excerpt,
      excerptPackBytes: excerpt.entry.bytes,
    },
  };
}

/** Upstream licence lookup: `GET api.github.com/repos/<o>/<r>/license?ref=<sha>`, unauthenticated only (never an operator token). */
export const GITHUB_LICENSE_API = "https://api.github.com";
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const SPDX_EXPRESSION_MAX = 200;

/**
 * An operator licence override: one SPDX id (`MIT`, `NOASSERTION`) or an SPDX licence expression
 * (`MIT AND CC-BY-4.0`, `Unlicense OR MIT`, `(MIT OR Apache-2.0) AND CC-BY-4.0`, `GPL-2.0-only WITH
 * Classpath-exception-2.0`). Operators are upper-case AND / OR / WITH, as SPDX requires; NOASSERTION only
 * stands alone. Returns the expression with normalised spacing, or undefined when it does not parse.
 */
export function normalizeSpdxLicenseOverride(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > SPDX_EXPRESSION_MAX) return undefined;
  const tokens = value.replace(/[()]/g, paren => ` ${paren} `).trim().split(/\s+/);
  if (tokens.length === 1) return SPDX_ID.test(tokens[0]!) ? tokens[0] : undefined;
  let at = 0;
  const operator = (token: string | undefined) => token === "AND" || token === "OR" || token === "WITH";
  const id = (): boolean => {
    const token = tokens[at];
    if (token === undefined || operator(token) || token === "(" || token === ")" || token === "NOASSERTION" || !SPDX_ID.test(token)) return false;
    at += 1;
    return true;
  };
  const term = (): boolean => {
    if (tokens[at] === "(") {
      at += 1;
      if (!expression() || tokens[at] !== ")") return false;
      at += 1;
      return true;
    }
    if (!id()) return false;
    if (tokens[at] === "WITH") { at += 1; return id(); }
    return true;
  };
  const expression = (): boolean => {
    if (!term()) return false;
    while (tokens[at] === "AND" || tokens[at] === "OR") {
      at += 1;
      if (!term()) return false;
    }
    return true;
  };
  if (!expression() || at !== tokens.length) return undefined;
  return tokens.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
}

/**
 * The licence recorded for a published version. No licence file, GitHub's `NOASSERTION`, or a failed lookup refuses the
 * publish unless the operator passes `override` (an SPDX id or expression, after checking the repository's terms by
 * hand); an override skips the lookup and records no URL.
 */
export async function resolvePublishedLicense(input: { owner: string; repo: string; commitSha: string; override?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<PublishedLicense> {
  if (input.override !== undefined) {
    const spdxId = normalizeSpdxLicenseOverride(input.override);
    if (spdxId === undefined) throw new Error('--license-override must be an SPDX id (MIT, Apache-2.0, NOASSERTION) or an SPDX expression ("MIT AND CC-BY-4.0", "Unlicense OR MIT")');
    return { spdxId, name: spdxId };
  }
  const refuse = (why: string): never => {
    throw new Error(`${why}; refusing to publish without a known licence (check the repository's terms, then pass --license-override <SPDX id or expression>)`);
  };
  if (!/^[A-Za-z0-9._-]+$/.test(input.owner) || !/^[A-Za-z0-9._-]+$/.test(input.repo) || !/^[a-f0-9]{40}$/.test(input.commitSha)) refuse("the publication's owner/repo/commit cannot be looked up on GitHub");
  const url = `${GITHUB_LICENSE_API}/repos/${input.owner}/${input.repo}/license?ref=${input.commitSha}`;
  let response: Response;
  try {
    // No Authorization header, ever: operator GitHub tokens are never used for publishing.
    response = await (input.fetch ?? fetch)(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sourcefor-publish", "x-github-api-version": "2022-11-28" },
      redirect: "follow",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch (cause) {
    return refuse(`the GitHub licence lookup for ${input.owner}/${input.repo} failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return refuse(`GitHub reports no licence file in ${input.owner}/${input.repo} at ${input.commitSha}`); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return refuse(`the GitHub licence lookup answered HTTP ${response.status}`); }
  let body: { path?: unknown; license?: { spdx_id?: unknown; name?: unknown } | null };
  try { body = await response.json() as typeof body; } catch { return refuse("the GitHub licence lookup returned invalid JSON"); }
  const spdxId = body.license?.spdx_id;
  if (typeof spdxId !== "string" || !SPDX_ID.test(spdxId) || spdxId === "NOASSERTION") return refuse(`GitHub could not identify the licence of ${input.owner}/${input.repo} (${typeof spdxId === "string" ? spdxId : "none"})`);
  if (typeof body.path !== "string" || !validSourcePath(body.path)) return refuse("the GitHub licence lookup returned no usable licence file path");
  const name = typeof body.license?.name === "string" && body.license.name.trim() ? body.license.name.trim().slice(0, 200) : spdxId;
  return {
    spdxId,
    name,
    url: `https://github.com/${input.owner}/${input.repo}/blob/${input.commitSha}/${body.path.split("/").map(encodeURIComponent).join("/")}`,
  };
}

/** GitHub's own casing of a repository's owner login and name (CLA-318), recorded in the index row. */
export interface GithubRepositoryNames { ownerLogin: string; repoName: string }
/**
 * The repository's GitHub description and primary language (CLA-269), from the same response as the names,
 * sanitised ({@link sanitizeGithubText}). `null`: the response has the key and it is null or empty (GitHub has none, so a
 * stored one is removed). Absent: the response lacks the key (a stored one is kept).
 */
export interface GithubRepositoryMeta { description?: string | null; language?: string | null }
export type GithubRepositoryInfo = GithubRepositoryNames & GithubRepositoryMeta;
/**
 * A GitHub repository lookup. `rateLimited`: GitHub refused it (HTTP 403 or 429) or said no requests are left
 * (`x-ratelimit-remaining: 0`), so a batch of lookups should stop here. Set only when true.
 */
export type GithubNamesLookup = ({ ok: true; rateLimited?: true } & GithubRepositoryInfo) | { ok: false; reason: string; rateLimited?: true };

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_DESCRIPTION_MAX = 280;
export const GITHUB_LANGUAGE_MAX = 40;
/**
 * Bidi controls and invisible characters: they can reorder or hide the text around them. U+200C/U+200D (zero-width
 * non-joiner/joiner) are kept: they hold emoji sequences (the woman mage, U+1F9D9 U+200D U+2640 U+FE0F) and some scripts
 * together. apps/web homePage.ts and home.js strip the same set.
 */
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Free text from GitHub made safe to store in the index: bidi and invisible characters ({@link INVISIBLE}) removed, control
 * characters (C0, DEL, C1) and runs of whitespace collapsed to one space, trimmed, and at most `max` code
 * points (a cut ends in `…`). Undefined for a non-string or when nothing is left. Idempotent.
 */
export function sanitizeGithubText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(INVISIBLE, "").replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const META_FIELDS = [["description", GITHUB_DESCRIPTION_MAX], ["language", GITHUB_LANGUAGE_MAX]] as const;

/**
 * Description and language from a GitHub repository body (or an index row), sanitised: a string, `null` when the key is
 * there but null or empty (nothing left after sanitising), and left out when the key is missing (or not a string or null).
 */
function githubMetaFrom(value: { description?: unknown; language?: unknown } | null | undefined): GithubRepositoryMeta {
  const meta: GithubRepositoryMeta = {};
  if (!value || typeof value !== "object") return meta;
  for (const [field, max] of META_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (raw === null || typeof raw === "string") meta[field] = sanitizeGithubText(raw, max) ?? null;
  }
  return meta;
}

/** Whether a GitHub response says to stop making requests: HTTP 403/429, or `x-ratelimit-remaining: 0`. */
function githubRateLimited(response: Response): boolean {
  return response.status === 403 || response.status === 429 || response.headers.get("x-ratelimit-remaining")?.trim() === "0";
}

/**
 * `GET api.github.com/repos/<owner>/<repo>` → `owner.login` and `name`, plus `description` and `language` (CLA-269, sanitised;
 * `null` when GitHub has none, left out when the response lacks the key; see {@link GithubRepositoryMeta}), with `rateLimited`
 * when GitHub refused (403/429) or has no requests left (see {@link GithubNamesLookup}), unauthenticated (never an operator token), like the licence lookup. Never throws: any failure is `{ ok: false, reason }` and the caller simply records nothing. GitHub
 * follows renames and transfers, so names that are not `owner`/`repo` ignoring case are refused rather than recorded.
 */
export async function resolveGithubRepositoryNames(input: { owner: string; repo: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<GithubNamesLookup> {
  const fail = (reason: string): GithubNamesLookup => ({ ok: false, reason });
  if (!GITHUB_NAME.test(input.owner) || !GITHUB_NAME.test(input.repo)) return fail("owner/repo cannot be looked up on GitHub");
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${GITHUB_LICENSE_API}/repos/${input.owner}/${input.repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sourcefor-publish", "x-github-api-version": "2022-11-28" },
      redirect: "follow",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch (cause) {
    return fail(`lookup failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  const limit = githubRateLimited(response) ? { rateLimited: true as const } : {};
  const refuse = (reason: string): GithubNamesLookup => ({ ok: false, reason, ...limit });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return refuse(`GitHub answered HTTP ${response.status}`); }
  let body: { name?: unknown; owner?: { login?: unknown } | null; description?: unknown; language?: unknown };
  try { body = await response.json() as typeof body; } catch { return refuse("GitHub returned invalid JSON"); }
  const ownerLogin = body?.owner?.login;
  const repoName = body?.name;
  if (typeof ownerLogin !== "string" || typeof repoName !== "string" || !GITHUB_NAME.test(ownerLogin) || !GITHUB_NAME.test(repoName)) return refuse("GitHub returned no usable owner.login / name");
  if (ownerLogin.toLowerCase() !== input.owner.toLowerCase() || repoName.toLowerCase() !== input.repo.toLowerCase()) {
    return refuse(`GitHub names it ${ownerLogin}/${repoName} (renamed or transferred?)`);
  }
  return { ok: true, ownerLogin, repoName, ...githubMetaFrom(body), ...limit };
}

/**
 * The row with GitHub's casing, description and language from one lookup (unchanged without one). A description or language
 * the lookup reports is set; one it reports as null or empty is removed; one it does not mention at all (the response
 * lacked the key) keeps the stored value, so a partial response never erases what the row already has.
 */
function withGithubNames(entry: PublishedIndexEntry, info: GithubRepositoryInfo | undefined): PublishedIndexEntry {
  if (!info) return entry;
  const next: PublishedIndexEntry = { ...entry, ownerLogin: info.ownerLogin, repoName: info.repoName };
  const meta = githubMetaFrom(info);
  for (const [field] of META_FIELDS) {
    const value = meta[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  return next;
}

/** Names already recorded on a row (see {@link recordedGithubNames}) with the description/language recorded beside them. */
function recordedGithubInfo(row: Partial<PublishedIndexEntry> | undefined): GithubRepositoryInfo | undefined {
  const names = recordedGithubNames(row);
  return names ? { ...names, ...githubMetaFrom(row) } : undefined;
}

/** Names already recorded on a row that still match its owner/repo ignoring case. */
function recordedGithubNames(row: Partial<PublishedIndexEntry> | undefined): GithubRepositoryNames | undefined {
  const { owner, repo, ownerLogin, repoName } = row ?? {};
  if (typeof owner !== "string" || typeof repo !== "string" || typeof ownerLogin !== "string" || typeof repoName !== "string") return undefined;
  if (!GITHUB_NAME.test(ownerLogin) || !GITHUB_NAME.test(repoName)) return undefined;
  return ownerLogin.toLowerCase() === owner.toLowerCase() && repoName.toLowerCase() === repo.toLowerCase() ? { ownerLogin, repoName } : undefined;
}

/**
 * Resolves the licence (a failure refuses the publish), then GitHub's casing of owner/repo (a failure only leaves the
 * row without it), then builds the version (what `pnpm publish:atlas` runs). The share card (CLA-319) is rendered only
 * when the casing lookup succeeded.
 */
export async function preparePublishedVersion(input: { scanRoot: string; repo: string; licenseOverride?: string; fetch?: typeof fetch; structureCard?: StructureCardRenderer; log?: (line: string) => void }): Promise<BuiltPublishedVersion> {
  const source = currentPublicationSource(input);
  const license = await resolvePublishedLicense({ ...source, ...(input.licenseOverride !== undefined ? { override: input.licenseOverride } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) });
  const githubNames = await resolveGithubRepositoryNames({ owner: source.owner, repo: source.repo, ...(input.fetch ? { fetch: input.fetch } : {}) });
  const built = buildPublishedVersion({
    scanRoot: input.scanRoot,
    repo: input.repo,
    license,
    ...(githubNames.ok ? { names: githubNames } : {}),
    // CLA-319: a stored card is permanent, so it is printed only with GitHub's own casing, never a guess.
    ...(input.structureCard && githubNames.ok ? { structureCard: input.structureCard } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
  if (input.structureCard && !githubNames.ok) {
    input.log?.(`no share card stored: GitHub's owner/repo casing is unknown (${githubNames.reason}); /og serves the generated card. Run --backfill-names, then --backfill-cards, to add one.`);
  }
  return { ...built, githubNames };
}

/** Where a publish reads existing objects from and writes new ones to. */
export interface PublishStoreClient {
  /** The object's bytes, or undefined when it does not exist. */
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
}

/**
 * Merges one entry into the remote index (same slug replaced; sorted by slug). An entry without GitHub's casing keeps the
 * names, description and language the replaced row already had (a failed lookup, or a `--set-latest` row rebuilt from a
 * manifest, never loses them); an entry with them (a successful lookup) refreshes all four.
 */
export function mergePublishedIndex(existing: Buffer | undefined, entry: PublishedIndexEntry): PublishedIndex {
  let repos: PublishedIndexEntry[] = [];
  let merged = entry;
  if (existing) {
    const parsed = JSON.parse(existing.toString("utf8")) as Partial<PublishedIndex>;
    if (parsed.schema !== PUBLISHED_INDEX_SCHEMA || !Array.isArray(parsed.repos)) throw new Error("the remote index.json is not a published index; refusing to overwrite it");
    if (!recordedGithubNames(entry)) {
      const previous = recordedGithubInfo(parsed.repos.find(value => value?.slug === entry.slug));
      if (previous && recordedGithubNames({ ...entry, ownerLogin: previous.ownerLogin, repoName: previous.repoName })) merged = withGithubNames(entry, previous);
    }
    repos = parsed.repos.filter(value => value && value.slug !== entry.slug);
  }
  repos.push(merged);
  repos.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { schema: PUBLISHED_INDEX_SCHEMA, schemaVersion: 1, repos };
}

export interface PublishResultSummary {
  /** `uploaded`: version objects written; `unchanged`: the identical version was already there (files skipped). */
  version: "uploaded" | "unchanged";
  objects: Array<{ key: string; bytes: number }>;
}

/**
 * Uploads a built version. Immutable: an existing version whose manifest differs is refused; the identical manifest
 * means the version is complete (manifest is written last), so only latest.json and index.json are rewritten — plus
 * the share card (CLA-319) when that version has none for this renderer yet: a card on a completed version is never
 * overwritten, and a card read/write failure there only warns.
 */
export async function publishBuiltVersion(built: BuiltPublishedVersion, client: PublishStoreClient, log: (line: string) => void = () => undefined): Promise<PublishResultSummary> {
  const written: Array<{ key: string; bytes: number }> = [];
  const put = async (key: string, bytes: Buffer, contentType: string) => {
    await client.put(key, bytes, contentType);
    written.push({ key, bytes: bytes.byteLength });
    log(`put ${key} (${bytes.byteLength} bytes)`);
  };
  // Preflight: the remote index must read cleanly (missing, or a published index) before anything is uploaded, so an
  // unreadable index fails the publish up front instead of after latest.json has moved.
  mergePublishedIndex(await client.get(publishedIndexKey()), built.indexEntry);
  const manifestKey = publishedManifestKey(built.slug, built.versionId);
  const existing = await client.get(manifestKey);
  let version: PublishResultSummary["version"] = "uploaded";
  if (existing) {
    if (!existing.equals(built.manifestBytes)) throw new Error(`refusing to overwrite ${manifestKey}: an existing version with different contents is published there`);
    version = "unchanged";
    log(`version ${built.slug}@${built.versionId} already published (identical manifest); skipping version objects`);
    const card = built.card && "key" in built.card ? built.card : undefined;
    if (card) {
      // Best effort: a card read/write failure must not stop latest.json and index.json moving.
      try {
        if (await client.get(card.key)) log(`share card ${card.key} already there; kept`);
        else await put(card.key, card.bytes, card.contentType);
      } catch (cause) {
        log(`WARNING: share card ${card.key} not stored (${cause instanceof Error ? cause.message : String(cause)}); /og serves the generated card; --backfill-cards can add it`);
      }
    }
  } else {
    for (const object of built.objects) await put(object.key, object.bytes, object.contentType);
    await put(manifestKey, built.manifestBytes, JSON_TYPE);
  }
  await put(publishedLatestKey(built.slug), built.latestBytes, JSON_TYPE);
  const index = mergePublishedIndex(await client.get(publishedIndexKey()), built.indexEntry);
  await put(publishedIndexKey(), Buffer.from(`${JSON.stringify(index, null, 2)}\n`), JSON_TYPE);
  return { version, objects: written };
}

/** Parses a manifest read back from the store for `--set-latest`; anything off refuses the rollback. */
function parseStoredManifest(bytes: Buffer, slug: string, versionId: string, owner: string, repo: string): PublishedVersionManifest {
  let value: Partial<PublishedVersionManifest>;
  try { value = JSON.parse(bytes.toString("utf8")) as Partial<PublishedVersionManifest>; } catch { throw new Error(`the manifest of ${slug}@${versionId} is not JSON; refusing to point latest at it`); }
  if (value.schema !== PUBLISHED_VERSION_SCHEMA || value.slug !== slug || value.versionId !== versionId) throw new Error(`the manifest of ${slug}@${versionId} does not describe that version; refusing to point latest at it`);
  if (typeof value.owner !== "string" || typeof value.repo !== "string" || value.owner.toLowerCase() !== owner.toLowerCase() || value.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`${slug}@${versionId} belongs to ${value.owner}/${value.repo}, not ${owner}/${repo}`);
  if (typeof value.publishedAt !== "string" || typeof value.snapshotRepositoryId !== "string" || typeof value.generatedAt !== "string" || !value.license || typeof value.license.spdxId !== "string") {
    throw new Error(`the manifest of ${slug}@${versionId} lacks the index fields (snapshotRepositoryId, generatedAt, license); re-publish that version instead`);
  }
  return value as PublishedVersionManifest;
}

/**
 * Rollback (`--set-latest <versionId>`): points a slug back at an immutable version already in the store. Checks that the
 * version's manifest exists (it is written last, so the version is complete), then rewrites latest.json and then the
 * merged index.json row from that manifest. Uploads nothing else.
 */
export async function setPublishedLatest(input: { repo: string; versionId: string; client: PublishStoreClient; log?: (line: string) => void }): Promise<{ slug: string; versionId: string; objects: Array<{ key: string; bytes: number }> }> {
  const log = input.log ?? (() => undefined);
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(input.repo.trim());
  if (!match) throw new Error("--repo must be owner/name");
  const [, owner, repo] = match as unknown as [string, string, string];
  if (!isPublishedVersionId(input.versionId)) throw new Error("--set-latest needs a published version id");
  // The slug the listing already uses for this repository, else the scanner's `<owner>__<repo>` directory slug.
  const listed = await input.client.get(publishedIndexKey());
  let slug: string | undefined;
  if (listed) {
    const index = JSON.parse(listed.toString("utf8")) as Partial<PublishedIndex>;
    if (index.schema !== PUBLISHED_INDEX_SCHEMA || !Array.isArray(index.repos)) throw new Error("the remote index.json is not a published index; refusing to overwrite it");
    slug = index.repos.find(entry => entry?.owner?.toLowerCase() === owner.toLowerCase() && entry.repo?.toLowerCase() === repo.toLowerCase())?.slug;
  }
  slug ??= parseGithubSource(`gh:${owner}/${repo}`)?.dirSlug.toLowerCase();
  if (!slug || !isPublishedSlug(slug)) throw new Error(`cannot derive a published slug for ${owner}/${repo}`);
  const manifestKey = publishedManifestKey(slug, input.versionId);
  const stored = await input.client.get(manifestKey);
  if (!stored) throw new Error(`${slug}@${input.versionId} is not in this store (no ${manifestKey}); nothing was changed`);
  const manifest = parseStoredManifest(stored, slug, input.versionId, owner, repo);
  const written: Array<{ key: string; bytes: number }> = [];
  const put = async (key: string, bytes: Buffer) => {
    await input.client.put(key, bytes, JSON_TYPE);
    written.push({ key, bytes: bytes.byteLength });
    log(`put ${key} (${bytes.byteLength} bytes)`);
  };
  await put(publishedLatestKey(slug), publishedLatestBytes(slug, manifest.versionId, manifest.publishedAt));
  const index = mergePublishedIndex(await input.client.get(publishedIndexKey()), publishedIndexEntryFor(manifest));
  await put(publishedIndexKey(), Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  return { slug, versionId: manifest.versionId, objects: written };
}

/**
 * Saves the index.json bytes a backfill is about to overwrite (a local file) and returns where they went. Called right before
 * the one write, with the bytes of the index as re-read for that write; if it throws, nothing is written.
 */
export type IndexBackup = (bytes: Buffer) => string | Promise<string>;

/**
 * Where a backfill's backup goes: `backup` resolved against `base` (the directory the command was run from: pnpm's
 * `INIT_CWD`, else the cwd) when given; else `backfill-backup-<env>-<UTC timestamp>.json` beside the `out` directory (a dry
 * run into a directory store: next to it, never inside the store) or in `base`.
 */
export function backfillBackupPath(input: { backup?: string; out?: string; env: string; base: string; now?: Date }): string {
  if (input.backup !== undefined) return resolve(input.base, input.backup);
  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = input.out !== undefined ? dirname(resolve(input.base, input.out)) : resolve(input.base);
  return join(dir, `backfill-backup-${input.env}-${stamp}.json`);
}

/**
 * An {@link IndexBackup} that writes a local file ({@link backfillBackupPath}; never overwrites one) and reads it back: bytes
 * that do not read back identically throw, so the backfill aborts before its write.
 */
export function fileIndexBackup(input: { backup?: string; out?: string; env: string; base: string; now?: () => Date; readBack?: (path: string) => Buffer }): IndexBackup {
  return bytes => {
    const target = backfillBackupPath({
      env: input.env,
      base: input.base,
      ...(input.backup !== undefined ? { backup: input.backup } : {}),
      ...(input.out !== undefined ? { out: input.out } : {}),
      ...(input.now ? { now: input.now() } : {}),
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx" });
    const back = (input.readBack ?? readFileSync)(target);
    if (!back.equals(bytes)) throw new Error(`the backup ${target} does not read back as written (${back.byteLength} of ${bytes.byteLength} bytes); nothing was written to the bucket`);
    return target;
  };
}

/**
 * A store client that can only read: `put` (and `delete`, should anything call one) throws. A dry-run backfill runs on this,
 * so no code path can write to the store it reads.
 */
export function readOnlyStoreClient(client: PublishStoreClient): PublishStoreClient & { delete(key: string): Promise<void> } {
  const refuse = (verb: string) => async (key: string): Promise<never> => { throw new Error(`dry run: refusing to ${verb} ${key} (the store client is read-only)`); };
  return { get: key => client.get(key), put: refuse("put"), delete: refuse("delete") };
}

interface BackfillIndexInput { client: PublishStoreClient; write: boolean; fetch?: typeof fetch; log?: (line: string) => void; backup?: IndexBackup }

/** Reads index.json for a backfill: undefined when missing; anything but a published index refuses the backfill. */
async function readIndexForBackfill(client: PublishStoreClient): Promise<{ index: PublishedIndex; bytes: Buffer } | undefined> {
  const bytes = await client.get(publishedIndexKey());
  if (!bytes) return undefined;
  let index: PublishedIndex;
  try { index = JSON.parse(bytes.toString("utf8")) as PublishedIndex; } catch { throw new Error("the remote index.json is not JSON; refusing to rewrite it"); }
  if (index.schema !== PUBLISHED_INDEX_SCHEMA || !Array.isArray(index.repos)) throw new Error("the remote index.json is not a published index; refusing to rewrite it");
  return { index, bytes };
}

/**
 * Backs up `previous` (when a backup is configured), writes the new index.json, then reads it back: bytes that differ from
 * what was written mean something else wrote index.json in between (a concurrent publish, whose row this write may have
 * dropped, or one that landed just after), which is reported loudly with the backup path. Returns the backup path and
 * whether the read-back matched.
 */
async function writeBackfilledIndex(client: PublishStoreClient, input: BackfillIndexInput, previous: Buffer, next: PublishedIndex, line: (text: string) => void): Promise<{ backupPath?: string; verified: boolean }> {
  let backupPath: string | undefined;
  if (input.backup) {
    backupPath = await input.backup(previous);
    line(`backup of the current index.json (${previous.byteLength} bytes) saved to ${backupPath}`);
  }
  const written = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  await client.put(publishedIndexKey(), written, JSON_TYPE);
  const readBack = await client.get(publishedIndexKey());
  const verified = readBack !== undefined && readBack.equals(written);
  if (!verified) {
    line(`WARNING: index.json read back after the write is ${readBack ? "not what this backfill wrote" : "missing"}. A publish that ran at the same time may have been overwritten (its row lost) or landed just after. Check index.json now; the index as it was before this write is in ${backupPath ?? "(no backup was configured)"}.`);
  }
  return { ...(backupPath ? { backupPath } : {}), verified };
}

/** Whether a row lacks GitHub's names, its description or its language (a backfill looks these up first). */
function rowMissingGithubInfo(row: Partial<PublishedIndexEntry> | null | undefined): boolean {
  return !recordedGithubNames(row ?? undefined) || typeof row?.description !== "string" || typeof row.language !== "string";
}

/** Rows in lookup order: those missing names or meta first, then the rest, each group in index order. */
function backfillLookupOrder(rows: readonly PublishedIndexEntry[]): PublishedIndexEntry[] {
  return [...rows.filter(row => rowMissingGithubInfo(row)), ...rows.filter(row => !rowMissingGithubInfo(row))];
}

/**
 * The line for a backfill that stopped at GitHub's rate limit: how many rows it never looked up (their rows stay as they
 * are; a later run picks them up first).
 */
function rateLimitLine(reason: string, notReached: number): string {
  return `stopped looking up at GitHub's rate limit (${reason}): ${notReached} row${notReached === 1 ? "" : "s"} not reached, left as they are; re-run after the limit resets`;
}

export interface BackfillNamesResult {
  /** One line per row: `<slug>: <what happened>`. */
  lines: string[];
  filled: number;
  alreadySet: number;
  failed: number;
  /** Rows never looked up because GitHub's rate limit stopped the lookups (left as they are). */
  notReached: number;
  /** True when index.json was rewritten (never on a dry run, never when nothing changed). */
  wrote: boolean;
  /** False when index.json, read back after the write, was not what was written (see the WARNING line). */
  verified: boolean;
  /** Where the overwritten index.json was saved (a write with a `backup` only). */
  backupPath?: string;
}

/**
 * One-off backfill (CLA-318, `publish:atlas --backfill-names`): fills `ownerLogin`/`repoName` on the rows of index.json that
 * lack them, from the GitHub API, and rewrites index.json only (no version, pointer or manifest is touched). Rows that
 * already have both are skipped without a lookup (idempotent); a failed lookup leaves its row unchanged. The same response's
 * description and language (CLA-269) go on the rows it fills. `write: false` (dry run) reads and reports only, through a
 * {@link readOnlyStoreClient}. Sequential lookups: unauthenticated GitHub allows 60 an hour; the first 403/429 or
 * `x-ratelimit-remaining: 0` stops the lookups, and only the rows already resolved are written.
 */
export async function backfillPublishedNames(input: BackfillIndexInput): Promise<BackfillNamesResult> {
  const log = input.log ?? (() => undefined);
  const client = input.write ? input.client : readOnlyStoreClient(input.client);
  const result: BackfillNamesResult = { lines: [], filled: 0, alreadySet: 0, failed: 0, notReached: 0, wrote: false, verified: true };
  const line = (text: string) => { result.lines.push(text); log(text); };
  const first = (await readIndexForBackfill(client))?.index;
  if (!first) { line("no index.json in this store; nothing to backfill"); return result; }
  // 1. Every lookup first (slow: network), keyed by the row's slug + owner + repo as read.
  const found = new Map<string, { owner: string; repo: string; names: GithubRepositoryInfo }>();
  let stopped: string | undefined;
  for (const row of first.repos) {
    const slug = typeof row?.slug === "string" ? row.slug : "(no slug)";
    const recorded = recordedGithubNames(row);
    if (recorded) {
      result.alreadySet += 1;
      line(`${slug}: already ${recorded.ownerLogin}/${recorded.repoName}`);
      continue;
    }
    if (stopped) { result.notReached += 1; continue; }
    const lookup = typeof row?.owner === "string" && typeof row.repo === "string"
      ? await resolveGithubRepositoryNames({ owner: row.owner, repo: row.repo, ...(input.fetch ? { fetch: input.fetch } : {}) })
      : { ok: false as const, reason: "row has no owner/repo" };
    if (lookup.rateLimited) stopped = lookup.ok ? "x-ratelimit-remaining is 0" : lookup.reason;
    if (!lookup.ok) {
      if (lookup.rateLimited) { result.notReached += 1; continue; }
      result.failed += 1;
      line(`${slug}: unchanged (${lookup.reason})`);
      continue;
    }
    const { ok: _ok, rateLimited: _rateLimited, ...names } = lookup;
    found.set(slug, { owner: row.owner, repo: row.repo, names });
  }
  if (stopped) line(rateLimitLine(stopped, result.notReached));
  if (!input.write) {
    for (const [slug, hit] of found) {
      result.filled += 1;
      line(`${slug}: ${hit.owner}/${hit.repo} → ${hit.names.ownerLogin}/${hit.names.repoName} (dry run)`);
    }
    return result;
  }
  if (found.size === 0) return result;
  // 2. Re-read right before the write, so a publish that landed during the lookups is never dropped: names go only on
  //    rows whose slug, owner and repo still match what was looked up and that still lack names. Everything else in the
  //    fresh index (other rows, field order, other keys) is written back as read.
  const fresh = await readIndexForBackfill(client);
  if (!fresh) { line("index.json disappeared during the backfill; nothing written"); return result; }
  const latest = fresh.index;
  const applied = new Set<string>();
  const repos = latest.repos.map(row => {
    const hit = typeof row?.slug === "string" ? found.get(row.slug) : undefined;
    if (!hit || row.owner !== hit.owner || row.repo !== hit.repo || recordedGithubNames(row)) return row;
    applied.add(row.slug);
    return withGithubNames(row, hit.names);
  });
  for (const [slug, hit] of found) {
    if (applied.has(slug)) {
      result.filled += 1;
      line(`${slug}: ${hit.owner}/${hit.repo} → ${hit.names.ownerLogin}/${hit.names.repoName}`);
    } else {
      line(`${slug}: skipped (the row changed or gained names during the backfill)`);
    }
  }
  if (applied.size > 0) {
    const written = await writeBackfilledIndex(client, input, fresh.bytes, { ...latest, repos }, line);
    if (written.backupPath) result.backupPath = written.backupPath;
    result.verified = written.verified;
    result.wrote = true;
  }
  return result;
}

export interface BackfillMetaResult {
  /** One line per row: `<slug>: <what happened>`. */
  lines: string[];
  /** Rows given new or refreshed names/description/language. */
  updated: number;
  /** Rows already matching GitHub (nothing to write). */
  upToDate: number;
  failed: number;
  /** Rows that changed in the store during the lookups (left as they are now). */
  skipped: number;
  /** Rows never looked up because GitHub's rate limit stopped the lookups (left as they are). */
  notReached: number;
  /** True when index.json was rewritten (never on a dry run, never when nothing changed). */
  wrote: boolean;
  /** False when index.json, read back after the write, was not what was written (see the WARNING line). */
  verified: boolean;
  /** Where the overwritten index.json was saved (a write with a `backup` only). */
  backupPath?: string;
}

function describeMetaChange(before: Partial<PublishedIndexEntry>, after: PublishedIndexEntry): string[] {
  const changes: string[] = [];
  if (before.ownerLogin !== after.ownerLogin || before.repoName !== after.repoName) changes.push(`names → ${after.ownerLogin}/${after.repoName}`);
  for (const field of ["description", "language"] as const) {
    const was = before[field];
    const now = after[field];
    if (was === now) continue;
    if (now === undefined) changes.push(`${field} removed`);
    else if (field === "language") changes.push(`language ${was === undefined ? "" : `${was} `}→ ${now}`);
    else changes.push(`description ${was === undefined ? "added" : "refreshed"} (${Array.from(now).length} chars)`);
  }
  return changes;
}

/**
 * Backfill (CLA-269, `publish:atlas --backfill-meta`): looks up EVERY row of index.json on the GitHub API (one request per
 * row, sequential: unauthenticated GitHub allows 60 an hour) and records its description and language, sanitised, filling
 * or refreshing them (one GitHub reports as null or empty is removed; one the response does not mention is kept); the same
 * response also fills or refreshes `ownerLogin`/`repoName`, so this is a superset of `--backfill-names`. Rewrites index.json
 * only. Rows missing names, description or language are looked up first, then the rest, so a run that hits the rate limit
 * (the first 403/429 or `x-ratelimit-remaining: 0` stops the lookups) still fills gaps; only rows already resolved are
 * written. A failed lookup (including a renamed or transferred repository) leaves its row unchanged. Before the one write
 * the index is re-read, and a row that changed in any way since it was looked up (a publish landed) is skipped. A run with
 * nothing new writes nothing. `write: false` (dry run) reads through a {@link readOnlyStoreClient}.
 */
export async function backfillPublishedMeta(input: BackfillIndexInput): Promise<BackfillMetaResult> {
  const log = input.log ?? (() => undefined);
  const client = input.write ? input.client : readOnlyStoreClient(input.client);
  const result: BackfillMetaResult = { lines: [], updated: 0, upToDate: 0, failed: 0, skipped: 0, notReached: 0, wrote: false, verified: true };
  const line = (text: string) => { result.lines.push(text); log(text); };
  const first = (await readIndexForBackfill(client))?.index;
  if (!first) { line("no index.json in this store; nothing to backfill"); return result; }
  // 1. Every lookup first (slow: network), gaps first, keyed by slug, remembering the row exactly as read.
  const planned = new Map<string, { asRead: string; next: PublishedIndexEntry; changes: string[] }>();
  let stopped: string | undefined;
  for (const row of backfillLookupOrder(first.repos)) {
    if (stopped) { result.notReached += 1; continue; }
    const slug = typeof row?.slug === "string" ? row.slug : "(no slug)";
    const lookup = typeof row?.slug === "string" && typeof row.owner === "string" && typeof row.repo === "string"
      ? await resolveGithubRepositoryNames({ owner: row.owner, repo: row.repo, ...(input.fetch ? { fetch: input.fetch } : {}) })
      : { ok: false as const, reason: "row has no slug/owner/repo" };
    if (lookup.rateLimited) stopped = lookup.ok ? "x-ratelimit-remaining is 0" : lookup.reason;
    if (!lookup.ok) {
      if (lookup.rateLimited) { result.notReached += 1; continue; }
      result.failed += 1;
      line(`${slug}: unchanged (${lookup.reason})`);
      continue;
    }
    const next = withGithubNames(row, lookup);
    const changes = describeMetaChange(row, next);
    // Nothing to change (at most a key-order difference): up to date, never an empty rewrite.
    if (changes.length === 0) {
      result.upToDate += 1;
      line(`${slug}: up to date`);
      continue;
    }
    if (planned.has(slug)) {
      result.skipped += 1;
      line(`${slug}: skipped (the slug is listed twice)`);
      continue;
    }
    planned.set(slug, { asRead: JSON.stringify(row), next, changes });
  }
  if (stopped) line(rateLimitLine(stopped, result.notReached));
  if (!input.write) {
    for (const [slug, plan] of planned) {
      result.updated += 1;
      line(`${slug}: ${plan.changes.join(", ")} (dry run)`);
    }
    return result;
  }
  if (planned.size === 0) return result;
  // 2. Re-read right before the write: a row is updated only if it is still exactly as it was looked up; everything else in
  //    the fresh index (other rows, new rows, field order, other keys) is written back as read.
  const fresh = await readIndexForBackfill(client);
  if (!fresh) { line("index.json disappeared during the backfill; nothing written"); return result; }
  const applied = new Set<string>();
  const repos = fresh.index.repos.map(row => {
    const plan = typeof row?.slug === "string" ? planned.get(row.slug) : undefined;
    if (!plan || applied.has(row.slug) || JSON.stringify(row) !== plan.asRead) return row;
    applied.add(row.slug);
    return plan.next;
  });
  for (const [slug, plan] of planned) {
    if (applied.has(slug)) {
      result.updated += 1;
      line(`${slug}: ${plan.changes.join(", ")}`);
    } else {
      result.skipped += 1;
      line(`${slug}: skipped (the row changed during the backfill)`);
    }
  }
  if (applied.size > 0) {
    const written = await writeBackfilledIndex(client, input, fresh.bytes, { ...fresh.index, repos }, line);
    if (written.backupPath) result.backupPath = written.backupPath;
    result.verified = written.verified;
    result.wrote = true;
  }
  return result;
}

export interface BackfillCardsResult {
  /** One line per row: `<slug> <versionId> <bytes> <action>`. */
  lines: string[];
  /** Cards rendered (dry run and write alike). */
  rendered: number;
  /** Cards put into the store (write mode only). */
  written: number;
  /** Rows whose version already has this renderer's card (never overwritten). */
  skippedExisting: number;
  /** Rows without GitHub's owner/repo casing recorded (run --backfill-names first; a card is never printed with a guess). */
  skippedNoNames: number;
  failed: number;
  /** Where the index.json bytes were saved before the first write (write mode with a `backup` only). */
  backupPath?: string;
}

/**
 * Backfill (CLA-319, `publish:atlas --backfill-cards`): for every index.json row (sorted by slug), renders the share card
 * of the row's version from that version's stored `public/snapshot.json` + `public/view.json` and puts it at
 * `versions/<v>/card-<renderer>.png` — only when that key is missing (an existing card is never overwritten; older
 * renderers' cards are left where they are). Printed names: the row's GitHub casing; a row without it is skipped (a stored
 * card is permanent, so it is never printed with a guess: run `--backfill-names` first). Never
 * deletes and never writes index.json, latest.json or a manifest. Every rendered PNG is also written to `previewDir` (as
 * `<slug>.png`) so a dry run can be looked at. `write: false` reads through a {@link readOnlyStoreClient}. Before the
 * first write the index.json bytes are saved through `backup` (a record of which versions were carded). A row that fails
 * (missing files, a render error) is reported and the rest continue.
 */
export async function backfillPublishedCards(input: {
  client: PublishStoreClient;
  write: boolean;
  structureCard: StructureCardRenderer;
  log?: (line: string) => void;
  previewDir?: string;
  backup?: IndexBackup;
}): Promise<BackfillCardsResult> {
  const log = input.log ?? (() => undefined);
  const client = input.write ? input.client : readOnlyStoreClient(input.client);
  const result: BackfillCardsResult = { lines: [], rendered: 0, written: 0, skippedExisting: 0, skippedNoNames: 0, failed: 0 };
  const line = (text: string) => { result.lines.push(text); log(text); };
  if (!isStructureCardRendererVersion(input.structureCard.version)) throw new Error(`invalid structure card renderer version ${JSON.stringify(input.structureCard.version)}`);
  const read = await readIndexForBackfill(client);
  if (!read) { line("no index.json in this store; nothing to backfill"); return result; }
  if (input.previewDir) mkdirSync(input.previewDir, { recursive: true });
  let backedUp = false;
  const rows = read.index.repos
    .filter(row => row && typeof row === "object")
    .sort((a, b) => (String(a.slug) < String(b.slug) ? -1 : String(a.slug) > String(b.slug) ? 1 : 0));
  for (const row of rows) {
    const slug = typeof row.slug === "string" ? row.slug : "(no slug)";
    const versionId = typeof row.versionId === "string" ? row.versionId : "(no version)";
    const report = (bytes: number | "-", action: string) => line(`${slug} ${versionId} ${bytes} ${action}`);
    const fail = (why: string) => { result.failed += 1; report("-", `failed (${why})`); };
    let card: PublishObject;
    try {
      if (!isPublishedSlug(slug) || !isPublishedVersionId(versionId)) { fail("the row has no valid slug/versionId"); continue; }
      const key = publishedCardKey(slug, versionId, input.structureCard.version);
      const existing = await client.get(key);
      if (existing) { result.skippedExisting += 1; report(existing.byteLength, "exists (kept)"); continue; }
      const names = recordedGithubNames(row);
      if (!names) { result.skippedNoNames += 1; report("-", "skipped (no GitHub owner/repo casing on the row; run --backfill-names first)"); continue; }
      const snapshotBytes = await client.get(publishedPublicFileKey(slug, versionId, "snapshot.json"));
      const viewBytes = await client.get(publishedPublicFileKey(slug, versionId, "view.json"));
      if (!snapshotBytes || !viewBytes) { fail("the version has no public snapshot.json/view.json"); continue; }
      const label = { owner: names.ownerLogin, repo: names.repoName };
      const rendered = renderStructureCardObject(input.structureCard, {
        slug,
        versionId,
        snapshot: JSON.parse(snapshotBytes.toString("utf8")) as ArchitectureSnapshot,
        view: JSON.parse(viewBytes.toString("utf8")) as ArchitectureView,
        label,
      });
      if ("error" in rendered) { fail(rendered.error); continue; }
      card = rendered;
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
      continue;
    }
    result.rendered += 1;
    const preview = input.previewDir ? join(input.previewDir, `${slug}.png`) : undefined;
    if (preview) writeFileSync(preview, card.bytes);
    if (!input.write) { report(card.bytes.byteLength, `rendered (dry run)${preview ? ` → ${preview}` : ""}`); continue; }
    // Before the first write: a failed backup aborts the run with nothing written.
    if (!backedUp && input.backup) {
      result.backupPath = await input.backup(read.bytes);
      line(`backup of the current index.json (${read.bytes.byteLength} bytes) saved to ${result.backupPath}`);
    }
    backedUp = true;
    try {
      await client.put(card.key, card.bytes, card.contentType);
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
      continue;
    }
    result.written += 1;
    report(card.bytes.byteLength, `written ${card.key}${preview ? ` (preview ${preview})` : ""}`);
  }
  return result;
}

/** Dry run: objects land in `<outDir>/<key>` (a store the published mirror can serve from over HTTP). */
export function createDirectoryStoreClient(outDir: string): PublishStoreClient {
  const pathFor = (key: string): string => {
    const target = resolve(outDir, key);
    if (!target.startsWith(resolve(outDir) + sep)) throw new Error("key escapes the output directory");
    return target;
  };
  return {
    async get(key) { const path = pathFor(key); return existsSync(path) ? readFileSync(path) : undefined; },
    async put(key, bytes) { const path = pathFor(key); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); },
  };
}

export interface WranglerRunResult { code: number; stdout: string; stderr: string }
export type WranglerRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<WranglerRunResult>;

/** `pnpm --filter @okie/edge exec wrangler ...` (argument array, no shell). */
export function pnpmWranglerRunner(cwd: string): WranglerRunner {
  return (args, env) => new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", ["--filter", "@okie/edge", "exec", "wrangler", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Credentials that make wrangler skip its `wrangler login` OAuth session. Publishing uses that session only, so these
 * are never handed to the child even when the environment or the repo-root .env defines them.
 */
export const WRANGLER_OVERRIDING_CREDENTIALS = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY"] as const;

/**
 * Child env for wrangler: the parent's env minus any API token / key (so the `wrangler login` OAuth session is used).
 * The account comes from CLOUDFLARE_ACCOUNT_ID when set, else from apps/edge/wrangler.jsonc `account_id` (wrangler runs
 * there). `ignored` names what was stripped.
 */
export function wranglerChildEnv(_env: PublishEnv, source: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; ignored: string[] } {
  const child: NodeJS.ProcessEnv = { ...source };
  const ignored: string[] = [];
  for (const name of WRANGLER_OVERRIDING_CREDENTIALS) {
    if (name in child) { if (child[name]?.trim()) ignored.push(name); delete child[name]; }
  }
  return { env: child, ignored };
}

/**
 * wrangler 4.x `r2 object get` on a missing key fails with exactly this UserError (local and remote). Nothing else counts
 * as "missing": any other failure is ambiguous and the read throws, so a publish never overwrites index.json from a
 * read it could not interpret.
 */
const MISSING_OBJECT = /^\s*(?:✘\s*)?\[ERROR\] The specified key does not exist\.\s*$/m;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function isWranglerMissingObject(result: WranglerRunResult): boolean {
  return result.code !== 0 && MISSING_OBJECT.test(`${result.stderr}\n${result.stdout}`.replace(ANSI, ""));
}

/** R2 through wrangler: `--remote` for staging/production, `--local [--persist-to]` for local. */
export function createWranglerStoreClient(input: { env: PublishEnv; persistTo?: string; run: WranglerRunner; childEnv: NodeJS.ProcessEnv }): PublishStoreClient {
  const bucket = PUBLISH_BUCKETS[input.env];
  const location = input.env === "local" ? ["--local", ...(input.persistTo ? ["--persist-to", resolve(input.persistTo)] : [])] : ["--remote"];
  const scratch = mkdtempSync(join(tmpdir(), "okie-publish-"));
  let counter = 0;
  const fail = (what: string, result: WranglerRunResult): never => {
    throw new Error(`wrangler ${what} failed (exit ${result.code}): ${`${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  };
  return {
    async get(key) {
      const file = join(scratch, `get-${counter += 1}`);
      const result = await input.run(["r2", "object", "get", `${bucket}/${key}`, "--file", file, ...location], input.childEnv);
      try {
        if (result.code !== 0) {
          if (isWranglerMissingObject(result)) return undefined;
          return fail(`r2 object get ${key}`, result);
        }
        // Success without the downloaded file is not "missing": it is unexplained, so it is an error.
        if (!existsSync(file)) return fail(`r2 object get ${key} (no file written)`, result);
        return readFileSync(file);
      } finally { rmSync(file, { force: true }); }
    },
    async put(key, bytes, contentType) {
      const file = join(scratch, `put-${counter += 1}`);
      writeFileSync(file, bytes);
      try {
        const result = await input.run(["r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", contentType, ...location], input.childEnv);
        if (result.code !== 0) fail(`r2 object put ${key}`, result);
      } finally { rmSync(file, { force: true }); }
    },
  };
}
