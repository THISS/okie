/**
 * CLA-266 published-atlas store layout: the one contract shared by the operator `publish` step
 * (writes), the edge Worker (serves public objects) and the read-only Ask container mirror
 * (reads public + private objects through the Worker's R2 binding).
 *
 * PURE module: no Node imports. The edge Worker bundles it for workerd.
 *
 *   atlas/v1/index.json                                   mutable  public listing of published atlases
 *   atlas/v1/repos/<slug>/latest.json                     mutable  { versionId } pointer for a slug
 *   atlas/v1/repos/<slug>/versions/<versionId>/manifest.json         immutable version manifest
 *   atlas/v1/repos/<slug>/versions/<versionId>/public/<file>         immutable public scan objects
 *   atlas/v1/repos/<slug>/versions/<versionId>/private/<file>        immutable, container-only (never served by the Worker)
 *   atlas/v1/repos/<slug>/versions/<versionId>/packs/<name>.pack     immutable packed precomputed packets
 *   atlas/v1/repos/<slug>/versions/<versionId>/packs/<name>.index.json  { encoding, entries: { key: [offset, length] } }
 *   atlas/v1/repos/<slug>/versions/<versionId>/packs/source-paths.json  paths the pinned source view may fetch
 *   atlas/v1/repos/<slug>/versions/<versionId>/card-<renderer>.png      immutable share card (CLA-319), optional
 *
 * `card-<renderer>.png` is the 1200×630 Open Graph card showing the version's real structure, rendered at publish
 * time (or by `publish:atlas --backfill-cards`) by apps/web/src/atlasStructureCard.ts; `<renderer>` is its
 * STRUCTURE_CARD_RENDERER_VERSION (`r1`, `r2`, …), so a new layout is a new key beside the old one and nothing is ever
 * overwritten. It is NOT listed in manifest.json: versions are immutable and a re-publish compares manifest bytes, so a
 * new field would make every existing version refuse to re-publish. It is found by key; `/og` falls back to the
 * generated owner/repo card when it is missing.
 *
 * A version is written completely (files, packs, manifest last) before `latest.json` moves, and
 * `index.json` is rewritten after that, so a reader that sees a pointer always finds its version.
 */

export const PUBLISHED_STORE_PREFIX = "atlas/v1/";
export const PUBLISHED_LATEST_SCHEMA = "okie.published-latest/v1";
export const PUBLISHED_VERSION_SCHEMA = "okie.published-version/v1";
export const PUBLISHED_INDEX_SCHEMA = "okie.published-index/v1";
export const PUBLISHED_PACK_INDEX_SCHEMA = "okie.published-pack-index/v1";
export const PUBLISHED_SOURCE_PATHS_SCHEMA = "okie.published-source-paths/v1";

/**
 * Scan objects the public `/scan/<slug>/<file>` surface may serve (mirrors `PUBLISHED_BASENAMES` in
 * scanObjects.ts, plus the public, claim-stripped `operator-explanations.json`).
 */
export const PUBLIC_SCAN_FILES: readonly string[] = [
  "snapshot.json",
  "view.json",
  "story.json",
  "stories.json",
  "scene.json",
  "timeline.json",
  "extraction.json",
  "enrichment-report.json",
  "enrichment-status.json",
  "operator-explanations.json",
];

/** Container-only files: the raw artifact sidecar keeps operator-only claim mappings. */
export const PRIVATE_SCAN_FILES: readonly string[] = ["operator-explanations.json"];

/** Precomputed packs. `neighborhood` keys are focus ids ("" = default view); `excerpt` keys are entity ids. */
export const PUBLISHED_PACKS = ["neighborhood", "excerpt"] as const;
export type PublishedPackName = (typeof PUBLISHED_PACKS)[number];

export interface PublishedLatestPointer {
  schema: typeof PUBLISHED_LATEST_SCHEMA;
  slug: string;
  versionId: string;
  publishedAt: string;
}

export interface PublishedFileEntry { bytes: number; sha256: string }

/** Upstream licence recorded at publish time (GitHub licence API at the pinned commit), shown as attribution. */
export interface PublishedLicense {
  /**
   * SPDX id, e.g. "MIT", or (operator override only) an SPDX expression such as "MIT AND CC-BY-4.0";
   * "NOASSERTION" only when the operator explicitly overrode a missing licence.
   */
  spdxId: string;
  name: string;
  /** Licence file URL pinned to the published commit. */
  url?: string;
}

export interface PublishedVersionManifest {
  schema: typeof PUBLISHED_VERSION_SCHEMA;
  slug: string;
  owner: string;
  repo: string;
  repositoryId: string;
  versionId: string;
  artifactRevisionId: string;
  commitSha: string;
  /** ISO timestamp of the operator publication. */
  publishedAt: string;
  previousVersionId?: string;
  entityCount: number;
  /** Snapshot identity and legacy landing timestamp fields used to rebuild the index on rollback. */
  snapshotRepositoryId: string;
  generatedAt: string;
  /** Explicit snapshot timestamp provenance; absent in legacy rows or snapshots without a timestamp. */
  snapshotGeneratedAt?: string;
  license: PublishedLicense;
  public: Record<string, PublishedFileEntry>;
  private: Record<string, PublishedFileEntry>;
  packs: Partial<Record<PublishedPackName, PublishedFileEntry & { entries: number; encoding: PublishedPackEncoding }>>;
  sourcePaths?: PublishedFileEntry;
}

export interface PublishedIndexEntry {
  slug: string;
  owner: string;
  repo: string;
  repositoryId: string;
  versionId: string;
  commitSha: string;
  /** Kept for the `/new` landing's existing ScanManifest reader. */
  generatedAt: string;
  /** Explicit snapshot timestamp provenance; absent in legacy rows or snapshots without a timestamp. */
  snapshotGeneratedAt?: string;
  entityCount: number;
  publishedAt: string;
  license: PublishedLicense;
  /**
   * CLA-318: GitHub's own casing of the owner login and repository name (`BurntSushi` where `owner` is
   * `burntsushi`), from `GET api.github.com/repos/<owner>/<repo>` at publish time or
   * `publish:atlas --backfill-names`. Optional: absent when the lookup failed; readers fall back to
   * `owner`/`repo`. Display only: slugs and canonical URLs never use them.
   */
  ownerLogin?: string;
  repoName?: string;
  /**
   * CLA-269: the repository's GitHub description (at most 280 code points) and primary language (at most 40), from the same
   * `GET api.github.com/repos/<owner>/<repo>` at publish time or `publish:atlas --backfill-meta`. Sanitised when written
   * (trimmed, single line, no control/bidi/zero-width characters); absent when GitHub has none or the lookup failed. Additive:
   * the schema version is unchanged and every index reader ignores fields it does not know. Display/search only.
   */
  description?: string;
  language?: string;
}

/** Superset of the scan `ScanManifest` (`schemaVersion: 1`, `repos`) so the landing list reads it unchanged. */
export interface PublishedIndex {
  schema: typeof PUBLISHED_INDEX_SCHEMA;
  schemaVersion: 1;
  repos: PublishedIndexEntry[];
}

/** `gzip`: every entry is its own complete gzip member (serve with Content-Encoding: gzip, or inflate). */
export type PublishedPackEncoding = "identity" | "gzip";

export interface PublishedPackIndex {
  schema: typeof PUBLISHED_PACK_INDEX_SCHEMA;
  encoding: PublishedPackEncoding;
  /** key → [byte offset, byte length] inside the matching `.pack` object. */
  entries: Record<string, [number, number]>;
}

/** Repository-relative paths recorded in the snapshot's sourceRefs at the published commit (source.json allowlist). */
export interface PublishedSourcePaths {
  schema: typeof PUBLISHED_SOURCE_PATHS_SCHEMA;
  owner: string;
  repo: string;
  commitSha: string;
  paths: string[];
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,180}$/;
const CARD_RENDERER = /^r[0-9]{1,4}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/;

export function isPublishedSlug(value: string): boolean { return SLUG.test(value); }
export function isPublishedVersionId(value: string): boolean { return VERSION.test(value); }
export function isStructureCardRendererVersion(value: string): boolean { return CARD_RENDERER.test(value); }

function slugOk(slug: string): string { if (!isPublishedSlug(slug)) throw new Error("invalid published slug"); return slug; }
function versionOk(versionId: string): string { if (!isPublishedVersionId(versionId)) throw new Error("invalid published version id"); return versionId; }
function fileOk(name: string, allowed: readonly string[]): string { if (!allowed.includes(name)) throw new Error("not a published file name"); return name; }

export const publishedIndexKey = (): string => `${PUBLISHED_STORE_PREFIX}index.json`;
export const publishedLatestKey = (slug: string): string => `${PUBLISHED_STORE_PREFIX}repos/${slugOk(slug)}/latest.json`;
export const publishedVersionPrefix = (slug: string, versionId: string): string => `${PUBLISHED_STORE_PREFIX}repos/${slugOk(slug)}/versions/${versionOk(versionId)}/`;
export const publishedManifestKey = (slug: string, versionId: string): string => `${publishedVersionPrefix(slug, versionId)}manifest.json`;
export const publishedPublicFileKey = (slug: string, versionId: string, name: string): string => `${publishedVersionPrefix(slug, versionId)}public/${fileOk(name, PUBLIC_SCAN_FILES)}`;
export const publishedPrivateFileKey = (slug: string, versionId: string, name: string): string => `${publishedVersionPrefix(slug, versionId)}private/${fileOk(name, PRIVATE_SCAN_FILES)}`;
export const publishedPackKey = (slug: string, versionId: string, pack: PublishedPackName): string => `${publishedVersionPrefix(slug, versionId)}packs/${pack}.pack`;
export const publishedPackIndexKey = (slug: string, versionId: string, pack: PublishedPackName): string => `${publishedVersionPrefix(slug, versionId)}packs/${pack}.index.json`;
export const publishedSourcePathsKey = (slug: string, versionId: string): string => `${publishedVersionPrefix(slug, versionId)}packs/source-paths.json`;
/** CLA-319: the version's share card as rendered by structure card renderer `renderer` (`r1`, `r2`, …). */
export const publishedCardKey = (slug: string, versionId: string, renderer: string): string => {
  if (!CARD_RENDERER.test(renderer)) throw new Error("invalid structure card renderer version");
  return `${publishedVersionPrefix(slug, versionId)}card-${renderer}.png`;
};

/** True for keys the edge Worker may return to the public (everything except `private/`). */
export function isPublicStoreKey(key: string): boolean {
  return key.startsWith(PUBLISHED_STORE_PREFIX) && !key.includes("..") && !/\/versions\/[^/]+\/private\//.test(key);
}
