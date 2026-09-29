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
  /** Immutable version objects (public/, private/, packs/), manifest excluded: it is written after all of them. */
  objects: PublishObject[];
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

export function buildPublishedVersion(input: { scanRoot: string; repo: string; license: PublishedLicense; now?: () => number; maxPackBytes?: number }): BuiltPublishedVersion {
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
    indexEntry: publishedIndexEntryFor(manifest),
    objects,
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

/** Resolves the licence, then builds the version (what `pnpm publish:atlas` runs). */
export async function preparePublishedVersion(input: { scanRoot: string; repo: string; licenseOverride?: string; fetch?: typeof fetch }): Promise<BuiltPublishedVersion> {
  const source = currentPublicationSource(input);
  const license = await resolvePublishedLicense({ ...source, ...(input.licenseOverride !== undefined ? { override: input.licenseOverride } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) });
  return buildPublishedVersion({ scanRoot: input.scanRoot, repo: input.repo, license });
}

/** Where a publish reads existing objects from and writes new ones to. */
export interface PublishStoreClient {
  /** The object's bytes, or undefined when it does not exist. */
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
}

/** Merges one entry into the remote index (same slug replaced; sorted by slug). */
export function mergePublishedIndex(existing: Buffer | undefined, entry: PublishedIndexEntry): PublishedIndex {
  let repos: PublishedIndexEntry[] = [];
  if (existing) {
    const parsed = JSON.parse(existing.toString("utf8")) as Partial<PublishedIndex>;
    if (parsed.schema !== PUBLISHED_INDEX_SCHEMA || !Array.isArray(parsed.repos)) throw new Error("the remote index.json is not a published index; refusing to overwrite it");
    repos = parsed.repos.filter(value => value && value.slug !== entry.slug);
  }
  repos.push(entry);
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
 * means the version is complete (manifest is written last), so only latest.json and index.json are rewritten.
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
