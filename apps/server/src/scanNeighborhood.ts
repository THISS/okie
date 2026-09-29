import { readFileSync, statSync } from "node:fs";
import type {
  ArchitectureNeighborhoodPacket,
  ArchitectureExcerptPacket,
  ArchitectureSnapshot,
  ArchitectureView,
} from "@okie/architecture";
import {
  excerptPacketForEntity,
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
} from "@okie/architecture";
import { resolvePublishedScanFile, resolvePublicationScanFile } from "./scanObjects.js";
import type { OperatorPublicationService } from "./operatorPublication.js";
import type { OperatorStore } from "./operatorStore.js";

const MAX_FOCUS_ID_LENGTH = 512;

type CachedPublishedTrio = {
  snapshotMtimeMs: number;
  viewMtimeMs: number;
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  publication?: { versionId: string; artifactRevisionId: string };
};

/**
 * Parsed trios keyed by snapshot path, least recently used first. Bounded (CLA-266: the read-only container has
 * limited memory and a snapshot can parse to hundreds of MB); `setPublishedTrioCacheLimit` / OKIE_NEIGHBORHOOD_CACHE_ENTRIES.
 */
const publishedCache = new Map<string, CachedPublishedTrio>();
export const DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES = 4;
let publishedCacheLimit = DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES;

/** Resize the parsed-trio LRU (at least one entry). */
export function setPublishedTrioCacheLimit(entries: number): void {
  publishedCacheLimit = Number.isSafeInteger(entries) && entries >= 1 ? entries : DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES;
  while (publishedCache.size > publishedCacheLimit) publishedCache.delete(publishedCache.keys().next().value!);
}

/** OKIE_NEIGHBORHOOD_CACHE_ENTRIES (default DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES). */
export function resolvePublishedTrioCacheEntries(env: NodeJS.Dict<string> = process.env): number {
  const value = Number.parseInt(env.OKIE_NEIGHBORHOOD_CACHE_ENTRIES ?? "", 10);
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES;
}

export type ScanNeighborhoodRequest = {
  pathname: string;
  searchParams: URLSearchParams;
  repositoryId?: string;
  publications?: OperatorPublicationService;
  store?: OperatorStore;
};

function scanPrefix(pathname: string): { slugPath: string; basename: string } | undefined {
  if (!pathname.startsWith("/scan/")) return undefined;
  const relative = pathname.slice("/scan/".length).replace(/\\/g, "/").replace(/^\/+/, "");
  if (relative === "" || relative.includes("..")) return undefined;
  const parts = relative.split("/");
  const basename = parts.at(-1);
  if (!basename) return undefined;
  const slugPath = parts.slice(0, -1).join("/");
  return { slugPath, basename };
}

export function isNeighborhoodScanPath(pathname: string): boolean {
  const parsed = scanPrefix(pathname);
  return parsed?.basename === "neighborhood.json";
}

export function isExcerptScanPath(pathname: string): boolean {
  const parsed = scanPrefix(pathname);
  return parsed?.basename === "excerpt.json";
}

/** The focus / entity id a `?focus=` or `?entity=` value names, or undefined (then the route serves the default / 404). */
export function sanitizeFocusId(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const id = raw.trim();
  if (!id || id.length > MAX_FOCUS_ID_LENGTH) return undefined;
  if (id.includes("..") || id.includes("/") || id.includes("\\") || /[\u0000-\u001f\u007f]/.test(id)) return undefined;
  return id;
}

function snapshotPathFor(slugPath: string): string {
  return slugPath ? `/scan/${slugPath}/snapshot.json` : "/scan/snapshot.json";
}

function viewPathFor(slugPath: string): string {
  return slugPath ? `/scan/${slugPath}/view.json` : "/scan/view.json";
}

function loadPublishedTrio(scanRoot: string, slugPath: string, request?: ScanNeighborhoodRequest): CachedPublishedTrio | undefined {
  let versionId = request?.searchParams.get("version") ?? undefined;
  let publication: CachedPublishedTrio["publication"];
  if (request?.repositoryId && request.publications) {
    versionId ??= request.publications.currentPublication(request.repositoryId)?.versionId;
    if (versionId) {
      const artifact = request.publications.artifactForVersion(request.repositoryId, versionId);
      if (!artifact) return undefined;
      publication = { versionId, artifactRevisionId: artifact.artifactRevisionId };
    }
  }
  if (versionId && !publication) return undefined;
  const resolver = (pathname: string) => request?.repositoryId && request.publications && request.store
    ? resolvePublicationScanFile({ scanRoot, pathname, repositoryId: request.repositoryId, ...(versionId ? { versionId } : {}), publications: request.publications, store: request.store })
    : resolvePublishedScanFile(scanRoot, pathname);
  const snapshotFile = resolver(snapshotPathFor(slugPath));
  const viewFile = resolver(viewPathFor(slugPath));
  if (!snapshotFile || !viewFile) return undefined;
  const snapshotMtimeMs = statSync(snapshotFile).mtimeMs;
  const viewMtimeMs = statSync(viewFile).mtimeMs;
  const cached = publishedCache.get(snapshotFile);
  if (cached && cached.snapshotMtimeMs === snapshotMtimeMs && cached.viewMtimeMs === viewMtimeMs) {
    publishedCache.delete(snapshotFile);
    publishedCache.set(snapshotFile, cached);
    return { ...cached, ...(publication ? { publication } : {}) };
  }
  // Drop the stale entry first so a re-parse never holds two copies of the same snapshot.
  publishedCache.delete(snapshotFile);
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as ArchitectureSnapshot;
  const view = JSON.parse(readFileSync(viewFile, "utf8")) as ArchitectureView;
  const entry = { snapshotMtimeMs, viewMtimeMs, snapshot, view };
  while (publishedCache.size >= publishedCacheLimit) publishedCache.delete(publishedCache.keys().next().value!);
  publishedCache.set(snapshotFile, entry);
  return { ...entry, ...(publication ? { publication } : {}) };
}

export function serveNeighborhoodPacket(
  scanRoot: string,
  request: ScanNeighborhoodRequest,
): (ArchitectureNeighborhoodPacket & { publication?: CachedPublishedTrio["publication"] }) | undefined {
  const parsed = scanPrefix(request.pathname);
  if (!parsed || parsed.basename !== "neighborhood.json") return undefined;
  const trio = loadPublishedTrio(scanRoot, parsed.slugPath, request);
  if (!trio) return undefined;
  return neighborhoodPacketFor(trio.snapshot, trio.view, {
    focus: request.searchParams.get("focus"),
    includeExcerpts: request.searchParams.get("excerpts") === "1",
    ...(trio.publication ? { publication: trio.publication } : {}),
  });
}

/**
 * The `/scan/<slug>/neighborhood.json` body for one parsed trio. Shared by the route and the CLA-266 publish precompute,
 * so a precomputed pack entry is byte-identical to what the route serves.
 */
export function neighborhoodPacketFor(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  input: { focus: string | null; includeExcerpts?: boolean; publication?: { versionId: string; artifactRevisionId: string } },
): ArchitectureNeighborhoodPacket & { publication?: { versionId: string; artifactRevisionId: string } } {
  const focusEntityId = sanitizeFocusId(input.focus);
  const packet = sliceArchitectureNeighborhood(snapshot, view, {
    ...(focusEntityId ? { focusEntityId } : {}),
    ...(input.includeExcerpts ? { includeExcerpts: true } : {}),
    ...neighborhoodSliceOptionsForFocus(snapshot, focusEntityId),
  });
  return { ...packet, ...(input.publication ? { publication: input.publication } : {}) };
}

/** The `/scan/<slug>/excerpt.json` body for one entity (undefined → the route's 404). */
export function excerptPacketFor(snapshot: ArchitectureSnapshot, entity: string | null): ArchitectureExcerptPacket | undefined {
  const entityId = sanitizeFocusId(entity);
  return entityId ? excerptPacketForEntity(snapshot, entityId) : undefined;
}

export function serveExcerptPacket(
  scanRoot: string,
  request: ScanNeighborhoodRequest,
): ArchitectureExcerptPacket | undefined {
  const parsed = scanPrefix(request.pathname);
  if (!parsed || parsed.basename !== "excerpt.json") return undefined;
  const trio = loadPublishedTrio(scanRoot, parsed.slugPath, request);
  if (!trio) return undefined;
  return excerptPacketFor(trio.snapshot, request.searchParams.get("entity"));
}

/** Test seam — the cached snapshot paths, least recently used first. */
export function publishedTrioCacheKeys(): string[] {
  return [...publishedCache.keys()];
}

/** Test seam — drop the parsed snapshot cache between cases. */
export function resetPublishedTrioCache(): void {
  publishedCache.clear();
}
