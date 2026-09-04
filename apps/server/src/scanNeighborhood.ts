import { readFileSync, statSync } from "node:fs";
import type {
  ArchitectureNeighborhoodPacket,
  ArchitectureExcerptPacket,
  ArchitectureSnapshot,
  ArchitectureView,
} from "@okie/architecture";
import {
  excerptPacketForEntity,
  sliceArchitectureNeighborhood,
} from "@okie/architecture";
import { resolvePublishedScanFile } from "./scanObjects.js";

const MAX_FOCUS_ID_LENGTH = 512;

type CachedPublishedTrio = {
  snapshotMtimeMs: number;
  viewMtimeMs: number;
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
};

const publishedCache = new Map<string, CachedPublishedTrio>();

export type ScanNeighborhoodRequest = {
  pathname: string;
  searchParams: URLSearchParams;
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

function sanitizeFocusId(raw: string | null): string | undefined {
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

function loadPublishedTrio(scanRoot: string, slugPath: string): CachedPublishedTrio | undefined {
  const snapshotFile = resolvePublishedScanFile(scanRoot, snapshotPathFor(slugPath));
  const viewFile = resolvePublishedScanFile(scanRoot, viewPathFor(slugPath));
  if (!snapshotFile || !viewFile) return undefined;
  const snapshotMtimeMs = statSync(snapshotFile).mtimeMs;
  const viewMtimeMs = statSync(viewFile).mtimeMs;
  const cached = publishedCache.get(snapshotFile);
  if (cached && cached.snapshotMtimeMs === snapshotMtimeMs && cached.viewMtimeMs === viewMtimeMs) {
    return cached;
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as ArchitectureSnapshot;
  const view = JSON.parse(readFileSync(viewFile, "utf8")) as ArchitectureView;
  const entry = { snapshotMtimeMs, viewMtimeMs, snapshot, view };
  publishedCache.set(snapshotFile, entry);
  return entry;
}

export function serveNeighborhoodPacket(
  scanRoot: string,
  request: ScanNeighborhoodRequest,
): ArchitectureNeighborhoodPacket | undefined {
  const parsed = scanPrefix(request.pathname);
  if (!parsed || parsed.basename !== "neighborhood.json") return undefined;
  const trio = loadPublishedTrio(scanRoot, parsed.slugPath);
  if (!trio) return undefined;
  const focusEntityId = sanitizeFocusId(request.searchParams.get("focus"));
  const includeExcerpts = request.searchParams.get("excerpts") === "1";
  return sliceArchitectureNeighborhood(trio.snapshot, trio.view, {
    ...(focusEntityId ? { focusEntityId } : {}),
    ...(includeExcerpts ? { includeExcerpts: true } : {}),
  });
}

export function serveExcerptPacket(
  scanRoot: string,
  request: ScanNeighborhoodRequest,
): ArchitectureExcerptPacket | undefined {
  const parsed = scanPrefix(request.pathname);
  if (!parsed || parsed.basename !== "excerpt.json") return undefined;
  const trio = loadPublishedTrio(scanRoot, parsed.slugPath);
  if (!trio) return undefined;
  const entityId = sanitizeFocusId(request.searchParams.get("entity"));
  if (!entityId) return undefined;
  return excerptPacketForEntity(trio.snapshot, entityId);
}

/** Test seam — drop the parsed snapshot cache between cases. */
export function resetPublishedTrioCache(): void {
  publishedCache.clear();
}
