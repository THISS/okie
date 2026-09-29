import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorArtifactRevision, OperatorPublication, OperatorRun } from "./operatorContracts.js";
import { canonicalOperatorRepositoryId, type OperatorStore, type OperatorStoreState } from "./operatorStore.js";
import {
  isPublishedSlug,
  isPublishedVersionId,
  PRIVATE_SCAN_FILES,
  PUBLIC_SCAN_FILES,
  PUBLISHED_INDEX_SCHEMA,
  PUBLISHED_LATEST_SCHEMA,
  PUBLISHED_VERSION_SCHEMA,
  publishedIndexKey,
  publishedLatestKey,
  publishedManifestKey,
  publishedPrivateFileKey,
  publishedPublicFileKey,
  type PublishedFileEntry,
  type PublishedVersionManifest,
} from "./publishedStoreLayout.js";

/**
 * CLA-266 published mirror for the read-only container. The container has no operator store: it materialises the
 * published atlas versions it serves (from the Worker's R2-backed `OKIE_PUBLISHED_STORE_URL`, one object per
 * `<url>/<key>`) into a minimal, valid operator-v1 store on scratch disk, so every existing read path — scan objects,
 * neighborhood / excerpt packets, the versioned source resolver, the Ask corpus and the block-plan source — runs
 * unchanged against it.
 *
 * Materialised shape (`<scanRoot>/operator-v1/`):
 *   state.json  { runs: one "complete" run per slug (source.slug/repositoryId/owner/repo/commitSha),
 *                 artifacts: one row per installed version's artifact (files, sourceCommitSha, sizeBytes),
 *                 publications: one row per installed version, drafts/attempts/explanations/events: [] }
 *   current/<sha256(canonical repositoryId)>.json   { versionId, artifactRevisionId, updatedAt } per slug's latest
 *   artifacts/<artifactRevisionId>/<file>           MIRRORED_PUBLIC_FILES (snapshot.json, view.json) plus
 *                                                   operator-explanations.json, the RAW sidecar from `private/` (the
 *                                                   server derives the claim-stripped public form from it)
 *
 * Every file is checked against the manifest's bytes + sha256 before it is installed (temp dir + rename). A failed
 * fetch never falls back to another version: the read answers its normal closed 404.
 */

export const DEFAULT_PUBLISHED_REFRESH_MS = 60_000;
export const DEFAULT_MAX_PINNED_VERSIONS = 4;
export const DEFAULT_MAX_PUBLISHED_FILE_BYTES = 256 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const POINTER_MAX_BYTES = 64 * 1024;
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,240}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The only files the container reads from a mirrored version. Every route it serves in public-readonly mode runs on
 * these: neighborhood / excerpt packets (snapshot + view), source.json's allowlist (snapshot), the Ask corpus and
 * block-plan source (snapshot + the RAW operator-explanations sidecar, taken from `private/`). The edge Worker serves
 * every public scan object (story/scene/timeline/extraction/enrichment reports, the claim-stripped sidecar) straight
 * from R2 and never proxies them to the container, so those are not downloaded; a container-side read of one is a
 * closed 404.
 */
export const MIRRORED_PUBLIC_FILES: readonly string[] = ["snapshot.json", "view.json"];

export interface PublishedMirrorOptions {
  /** `OKIE_PUBLISHED_STORE_URL`: objects are read from `<storeUrl>/<key>`. */
  storeUrl: string;
  /** The server's operator store over the mirror's scan root (the mirror is its only writer). */
  store: OperatorStore;
  fetch?: typeof fetch;
  /** OKIE_PUBLISHED_REFRESH_MS; default DEFAULT_PUBLISHED_REFRESH_MS. */
  refreshMs?: number;
  /** Non-latest versions kept for pinned (`?version=`) sessions, least recently used evicted first. */
  maxPinnedVersions?: number;
  maxFileBytes?: number;
  /** Concurrent on-demand installs; further misses answer 404 at once rather than queue. */
  maxOnDemand?: number;
  /** How long a missing slug / version is remembered before it is looked up again. */
  negativeTtlMs?: number;
  /** Longest an on-demand request waits for an install (the install keeps going in the background). */
  onDemandWaitMs?: number;
  requestTimeoutMs?: number;
  /** Minimum gap between request-triggered latest.json re-reads for one slug (default 10 s). */
  latestRecheckMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PublishedMirror {
  /** Full sync: index → every slug's latest → manifest → files. Never throws (errors are logged). */
  sync(): Promise<void>;
  /** Periodic refresh: re-reads the index, and each slug's pointer only when the index changed. Never throws. */
  refresh(): Promise<void>;
  /**
   * On-demand: make `slug`'s latest (and `versionId`, when given) available. When the request names a version or commit
   * that is not the mirror's current one, latest.json is re-read first (at most once per `latestRecheckMs` per slug), so
   * a missed refresh cannot pin the mirror to an old version. Bounded, deduped; never throws.
   */
  ensure(slug: string, versionId?: string, hint?: { commitSha?: string }): Promise<void>;
  start(): void;
  stop(): void;
  stats(): { slugs: string[]; versions: number; installs: number; fetches: number; failures: number };
}

interface InstalledVersion {
  slug: string;
  versionId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  commitSha: string;
  artifactRevisionId: string;
  files: string[];
  sizeBytes: number;
  publishedAt: number;
  previousVersionId?: string;
  lastUsed: number;
}

class NotFound extends Error {}

const versionKey = (slug: string, versionId: string): string => `${slug}\u0000${versionId}`;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** The operator store's own pointer file name (OperatorPublicationService.path). */
export function publicationPointerPath(storeRoot: string, repositoryId: string): string {
  return join(storeRoot, "current", `${createHash("sha256").update(canonicalOperatorRepositoryId(repositoryId)).digest("hex")}.json`);
}

function isFileEntry(value: unknown): value is PublishedFileEntry {
  const entry = value as PublishedFileEntry | undefined;
  return typeof entry === "object" && entry !== null && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && typeof entry.sha256 === "string" && SHA256.test(entry.sha256);
}

/** Structural checks on a fetched manifest; anything off is treated as "not published". */
export function parsePublishedManifest(bytes: Buffer, slug: string, versionId: string): PublishedVersionManifest {
  const value = JSON.parse(bytes.toString("utf8")) as PublishedVersionManifest;
  const ok = value && value.schema === PUBLISHED_VERSION_SCHEMA && value.slug === slug && value.versionId === versionId
    && typeof value.artifactRevisionId === "string" && ARTIFACT_ID.test(value.artifactRevisionId) && !value.artifactRevisionId.includes("..")
    && typeof value.repositoryId === "string" && REPOSITORY_ID.test(value.repositoryId)
    && typeof value.owner === "string" && typeof value.repo === "string" && typeof value.commitSha === "string"
    && typeof value.publishedAt === "string" && Number.isFinite(Date.parse(value.publishedAt))
    && typeof value.public === "object" && value.public !== null && typeof value.private === "object" && value.private !== null
    && Object.entries(value.public).every(([name, entry]) => PUBLIC_SCAN_FILES.includes(name) && isFileEntry(entry))
    && Object.entries(value.private).every(([name, entry]) => PRIVATE_SCAN_FILES.includes(name) && isFileEntry(entry));
  if (!ok) throw new Error("invalid published manifest");
  return value;
}

export function createPublishedMirror(options: PublishedMirrorOptions): PublishedMirror {
  const base = options.storeUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => undefined);
  const refreshMs = options.refreshMs ?? DEFAULT_PUBLISHED_REFRESH_MS;
  const maxPinned = options.maxPinnedVersions ?? DEFAULT_MAX_PINNED_VERSIONS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_PUBLISHED_FILE_BYTES;
  const maxOnDemand = options.maxOnDemand ?? 4;
  const negativeTtlMs = options.negativeTtlMs ?? refreshMs;
  const onDemandWaitMs = options.onDemandWaitMs ?? 20_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const latestRecheckMs = options.latestRecheckMs ?? 10_000;
  const artifactsRoot = join(store.root, "artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  mkdirSync(join(store.root, "current"), { recursive: true });

  const versions = new Map<string, InstalledVersion>();
  const current = new Map<string, string>();
  const missing = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  let onDemand = 0;
  /** Digest of the last index every listed slug synced from; it only advances when the whole pass succeeded. */
  let lastIndexDigest: string | undefined;
  /** Slugs whose last sync failed: retried on every refresh until they succeed, even when the index is unchanged. */
  const retry = new Set<string>();
  /** When each slug's latest.json was last re-read because a request named a version/commit the mirror lacks. */
  const lastRecheck = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const counters = { installs: 0, fetches: 0, failures: 0 };

  const url = (key: string): string => `${base}/${key}`;

  async function get(key: string, maxBytes: number): Promise<Buffer> {
    counters.fetches += 1;
    const response = await fetchImpl(url(key), { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); throw new NotFound(key); }
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error(`published store answered ${response.status}`); }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body.cancel().catch(() => undefined); throw new Error("published object too large"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) throw new Error("published object too large");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks);
  }

  const isMissing = (key: string): boolean => {
    const until = missing.get(key);
    if (until === undefined) return false;
    if (until > now()) return true;
    missing.delete(key);
    return false;
  };
  const markMissing = (key: string): void => {
    missing.delete(key);
    missing.set(key, now() + negativeTtlMs);
    while (missing.size > 1024) missing.delete(missing.keys().next().value!);
  };

  /** Rewrites state.json (temp + rename, under the store lock) and every slug's pointer from the in-memory tables. */
  function writeState(): void {
    const installed = [...versions.values()];
    const runs: OperatorRun[] = [];
    for (const slug of new Set(installed.map(value => value.slug))) {
      const latest = installed.find(value => value.slug === slug && current.get(slug) === value.versionId) ?? installed.find(value => value.slug === slug)!;
      runs.push({
        runId: `mirror-${slug}`,
        idempotencyKey: `mirror-${slug}`,
        source: { repositoryId: latest.repositoryId, owner: latest.owner, repo: latest.repo, slug, commitSha: latest.commitSha },
        state: "complete",
        createdAt: latest.publishedAt,
        updatedAt: latest.publishedAt,
      });
    }
    const artifacts = new Map<string, OperatorArtifactRevision>();
    for (const value of installed) {
      artifacts.set(value.artifactRevisionId, {
        artifactRevisionId: value.artifactRevisionId,
        repositoryId: value.repositoryId,
        ...(value.commitSha ? { sourceCommitSha: value.commitSha } : {}),
        createdAt: value.publishedAt,
        files: [...value.files].sort(),
        sizeBytes: value.sizeBytes,
      });
    }
    const publications: OperatorPublication[] = installed.map(value => ({
      versionId: value.versionId,
      repositoryId: value.repositoryId,
      draftRevisionId: `mirror-draft-${value.versionId}`,
      artifactRevisionId: value.artifactRevisionId,
      ...(value.previousVersionId ? { previousVersionId: value.previousVersionId } : {}),
      createdAt: value.publishedAt,
    }));
    const state: OperatorStoreState = { runs, drafts: [], attempts: [], explanations: [], events: [], artifacts: [...artifacts.values()], publications };
    store.withExclusiveLock(() => {
      const statePath = join(store.root, "state.json");
      const temp = `${statePath}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temp, statePath);
      // Pointers after the rows they name: a reader that sees a pointer finds its publication.
      for (const [slug, versionId] of current) {
        const value = versions.get(versionKey(slug, versionId));
        if (!value) continue;
        const target = publicationPointerPath(store.root, value.repositoryId);
        const pointerTemp = `${target}.${randomUUID()}.tmp`;
        writeFileSync(pointerTemp, `${JSON.stringify({ versionId, artifactRevisionId: value.artifactRevisionId, updatedAt: value.publishedAt })}\n`, { mode: 0o600 });
        renameSync(pointerTemp, target);
      }
    });
  }

  /** Removes artifact directories no installed version references any more. */
  function dropArtifacts(candidates: Iterable<string>): void {
    const referenced = new Set([...versions.values()].map(value => value.artifactRevisionId));
    for (const artifactRevisionId of candidates) {
      if (!referenced.has(artifactRevisionId)) rmSync(join(artifactsRoot, artifactRevisionId), { recursive: true, force: true });
    }
  }

  /** Keeps every slug's latest plus the `maxPinned` most recently used other versions. */
  function evictPinned(): void {
    const pinned = [...versions.values()].filter(value => current.get(value.slug) !== value.versionId).sort((a, b) => b.lastUsed - a.lastUsed);
    const evicted = pinned.slice(maxPinned);
    if (!evicted.length) return;
    for (const value of evicted) versions.delete(versionKey(value.slug, value.versionId));
    writeState();
    dropArtifacts(evicted.map(value => value.artifactRevisionId));
  }

  async function downloadArtifact(manifest: PublishedVersionManifest): Promise<{ files: string[]; sizeBytes: number }> {
    const plan: Array<{ name: string; key: string; entry: PublishedFileEntry }> = [];
    for (const [name, entry] of Object.entries(manifest.private)) plan.push({ name, key: publishedPrivateFileKey(manifest.slug, manifest.versionId, name), entry });
    for (const [name, entry] of Object.entries(manifest.public)) {
      // The raw private sidecar is the artifact's operator-explanations.json; the public (claim-stripped) copy is the Worker's.
      if (!MIRRORED_PUBLIC_FILES.includes(name)) continue;
      plan.push({ name, key: publishedPublicFileKey(manifest.slug, manifest.versionId, name), entry });
    }
    const files = plan.map(item => item.name);
    const sizeBytes = plan.reduce((sum, item) => sum + item.entry.bytes, 0);
    const destination = join(artifactsRoot, manifest.artifactRevisionId);
    if (existsSync(destination)) return { files, sizeBytes };
    const temp = join(artifactsRoot, `.${manifest.artifactRevisionId}.${randomUUID()}.tmp`);
    mkdirSync(temp, { recursive: true });
    try {
      for (const item of plan) {
        if (item.entry.bytes > maxFileBytes) throw new Error("published file exceeds the mirror cap");
        const bytes = await get(item.key, item.entry.bytes);
        if (bytes.byteLength !== item.entry.bytes || sha256(bytes) !== item.entry.sha256) throw new Error(`published file ${item.name} does not match its manifest`);
        writeFileSync(join(temp, item.name), bytes, { mode: 0o600 });
      }
      if (existsSync(destination)) rmSync(temp, { recursive: true, force: true });
      else renameSync(temp, destination);
    } catch (cause) {
      rmSync(temp, { recursive: true, force: true });
      throw cause;
    }
    return { files, sizeBytes };
  }

  /** Fetches, verifies and installs one version (not made current here). */
  async function installVersion(slug: string, versionId: string): Promise<InstalledVersion> {
    const existing = versions.get(versionKey(slug, versionId));
    if (existing) return existing;
    const manifest = parsePublishedManifest(await get(publishedManifestKey(slug, versionId), MANIFEST_MAX_BYTES), slug, versionId);
    const { files, sizeBytes } = await downloadArtifact(manifest);
    const installed: InstalledVersion = {
      slug,
      versionId,
      repositoryId: canonicalOperatorRepositoryId(manifest.repositoryId),
      owner: manifest.owner,
      repo: manifest.repo,
      commitSha: manifest.commitSha,
      artifactRevisionId: manifest.artifactRevisionId,
      files,
      sizeBytes,
      publishedAt: Date.parse(manifest.publishedAt),
      ...(manifest.previousVersionId ? { previousVersionId: manifest.previousVersionId } : {}),
      lastUsed: now(),
    };
    versions.set(versionKey(slug, versionId), installed);
    counters.installs += 1;
    writeState();
    log(`mirrored ${slug}@${versionId}`);
    return installed;
  }

  /** Drops every version of an unpublished slug. */
  function dropSlug(slug: string): void {
    const gone = [...versions.values()].filter(value => value.slug === slug);
    const repositoryIds = new Set(gone.map(value => value.repositoryId));
    current.delete(slug);
    for (const value of gone) versions.delete(versionKey(slug, value.versionId));
    writeState();
    for (const repositoryId of repositoryIds) rmSync(publicationPointerPath(store.root, repositoryId), { force: true });
    dropArtifacts(gone.map(value => value.artifactRevisionId));
    log(`unpublished ${slug}`);
  }

  /** Reads `slug`'s latest pointer and installs + promotes it when it moved. */
  async function syncLatest(slug: string): Promise<void> {
    let pointer: { schema?: unknown; slug?: unknown; versionId?: unknown };
    try {
      pointer = JSON.parse((await get(publishedLatestKey(slug), POINTER_MAX_BYTES)).toString("utf8")) as typeof pointer;
    } catch (cause) {
      if (cause instanceof NotFound) {
        markMissing(`slug:${slug}`);
        if (current.has(slug)) dropSlug(slug);
        return;
      }
      throw cause;
    }
    if (pointer.schema !== PUBLISHED_LATEST_SCHEMA || pointer.slug !== slug || typeof pointer.versionId !== "string" || !isPublishedVersionId(pointer.versionId)) throw new Error("invalid published pointer");
    if (current.get(slug) === pointer.versionId) return;
    const installed = await installVersion(slug, pointer.versionId);
    installed.lastUsed = now();
    current.set(slug, installed.versionId);
    missing.delete(`slug:${slug}`);
    writeState();
    evictPinned();
  }

  const dedupe = (key: string, work: () => Promise<void>): Promise<void> => {
    const pending = inflight.get(key);
    if (pending) return pending;
    const started = work().finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };

  const report = (what: string) => (cause: unknown): void => {
    counters.failures += 1;
    log(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300));
  };

  /** Syncs each slug's latest; returns the slugs that failed (and keeps them in the retry set). */
  async function refreshSlugs(slugs: Iterable<string>): Promise<Set<string>> {
    const failed = new Set<string>();
    for (const slug of new Set(slugs)) {
      try { await dedupe(`latest:${slug}`, () => syncLatest(slug)); retry.delete(slug); } catch (cause) {
        report(`sync ${slug}`)(cause);
        failed.add(slug);
        retry.add(slug);
      }
    }
    return failed;
  }

  async function readIndexSlugs(): Promise<{ slugs: string[]; digest: string } | undefined> {
    let bytes: Buffer;
    try { bytes = await get(publishedIndexKey(), INDEX_MAX_BYTES); } catch (cause) {
      if (cause instanceof NotFound) return { slugs: [], digest: "missing" };
      throw cause;
    }
    const index = JSON.parse(bytes.toString("utf8")) as { schema?: unknown; repos?: Array<{ slug?: unknown }> };
    if (index.schema !== PUBLISHED_INDEX_SCHEMA || !Array.isArray(index.repos)) throw new Error("invalid published index");
    const slugs = index.repos.map(entry => entry?.slug).filter((slug): slug is string => typeof slug === "string" && isPublishedSlug(slug));
    return { slugs, digest: sha256(bytes) };
  }

  async function refreshFrom(force: boolean): Promise<void> {
    let index: Awaited<ReturnType<typeof readIndexSlugs>>;
    try { index = await readIndexSlugs(); } catch (cause) { report("index")(cause); return; }
    if (!index) return;
    if (!force && index.digest === lastIndexDigest) {
      // Unchanged index: only the slugs whose last sync failed are retried.
      if (retry.size) await refreshSlugs([...retry].filter(slug => index.slugs.includes(slug) || current.has(slug)));
      return;
    }
    const failed = await refreshSlugs([...index.slugs, ...current.keys()]);
    // Advance only when every slug synced: a failed install is retried against this index on the next refresh.
    if (!failed.size) lastIndexDigest = index.digest;
  }

  const withDeadline = (work: Promise<void>): Promise<void> => new Promise(resolve => {
    const timeout = setTimeout(resolve, onDemandWaitMs);
    timeout.unref?.();
    void work.catch(() => undefined).finally(() => { clearTimeout(timeout); resolve(); });
  });

  /** Bounded on-demand work: over `maxOnDemand` concurrent installs the request answers at once (a closed 404). */
  function onDemandInstall(key: string, work: () => Promise<void>): Promise<void> {
    const pending = inflight.get(key);
    if (pending) return withDeadline(pending);
    if (onDemand >= maxOnDemand) return Promise.resolve();
    onDemand += 1;
    const started = dedupe(key, work).finally(() => { onDemand -= 1; });
    return withDeadline(started);
  }

  return {
    sync: () => refreshFrom(true),
    refresh: () => refreshFrom(false),
    async ensure(slug, versionId, hint) {
      if (!isPublishedSlug(slug)) return;
      if (versionId !== undefined && !isPublishedVersionId(versionId)) versionId = undefined;
      const commitSha = typeof hint?.commitSha === "string" && /^[a-f0-9]{40}$/.test(hint.commitSha) ? hint.commitSha : undefined;
      if (!current.has(slug)) {
        if (isMissing(`slug:${slug}`)) return;
        await onDemandInstall(`latest:${slug}`, () => syncLatest(slug).catch(cause => { markMissing(`slug:${slug}`); throw cause; }));
        if (!current.has(slug)) return;
      } else {
        // The request names a version/commit that is not current: latest may have moved since the last refresh.
        const live = versions.get(versionKey(slug, current.get(slug)!));
        const stale = (versionId !== undefined && versionId !== current.get(slug)) || (commitSha !== undefined && live !== undefined && live.commitSha !== commitSha);
        const last = lastRecheck.get(slug);
        const pending = inflight.get(`latest:${slug}`);
        if (stale && pending) await withDeadline(pending);
        else if (stale && (last === undefined || now() - last >= latestRecheckMs)) {
          lastRecheck.set(slug, now());
          await onDemandInstall(`latest:${slug}`, () => syncLatest(slug).then(() => { retry.delete(slug); }));
        }
      }
      if (versionId === undefined) return;
      const installed = versions.get(versionKey(slug, versionId));
      if (installed) { installed.lastUsed = now(); return; }
      const key = `version:${slug}:${versionId}`;
      if (isMissing(key)) return;
      await onDemandInstall(key, async () => {
        try { await installVersion(slug, versionId); evictPinned(); } catch (cause) { markMissing(key); throw cause; }
      });
    },
    start() {
      if (timer || refreshMs <= 0) return;
      timer = setInterval(() => { void this.refresh(); }, refreshMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    stats: () => ({ slugs: [...current.keys()].sort(), versions: versions.size, ...counters }),
  };
}

/** OKIE_PUBLISHED_REFRESH_MS (default DEFAULT_PUBLISHED_REFRESH_MS; 0 disables the timer). */
export function resolvePublishedRefreshMs(env: NodeJS.Dict<string> = process.env): number {
  const value = Number.parseInt(env.OKIE_PUBLISHED_REFRESH_MS ?? "", 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_PUBLISHED_REFRESH_MS;
}
