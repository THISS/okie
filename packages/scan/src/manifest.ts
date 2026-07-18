import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-repo entry in the scan manifest. One row per scanned repository directory under
 * `fixtures/scan/<slug>/`. Everything is input-derived (from the snapshot), so the
 * manifest is a pure function of the on-disk scan set — regenerating it is stable.
 */
export interface ScanManifestEntry {
  slug: string;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  entityCount: number;
}

export interface ScanManifest {
  schemaVersion: 1;
  repos: ScanManifestEntry[];
}

interface ManifestSnapshotShape {
  repositoryId?: unknown;
  commitSha?: unknown;
  entities?: unknown;
}

/**
 * Builds a manifest from raw entries: dedupes by slug (last write wins) and sorts by
 * slug so the bytes are independent of scan/enumeration order. Pure — the unit under
 * the manifest-determinism test.
 */
export function buildScanManifest(entries: readonly ScanManifestEntry[]): ScanManifest {
  const bySlug = new Map<string, ScanManifestEntry>();
  for (const entry of entries) bySlug.set(entry.slug, entry);
  const repos = [...bySlug.values()].sort((left, right) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0);
  return { schemaVersion: 1, repos };
}

/** Derives one manifest entry from a parsed snapshot document; undefined if it is not a scan snapshot. */
export function manifestEntryFromSnapshot(slug: string, snapshot: unknown): ScanManifestEntry | undefined {
  const record = snapshot as ManifestSnapshotShape & { generatedAt?: unknown };
  const repositoryId = typeof record.repositoryId === "string" ? record.repositoryId : undefined;
  const commitSha = typeof record.commitSha === "string" ? record.commitSha : undefined;
  const generatedAt = typeof record.generatedAt === "string" ? record.generatedAt : undefined;
  const entityCount = Array.isArray(record.entities) ? record.entities.length : undefined;
  if (!repositoryId || !commitSha || !generatedAt || entityCount === undefined) return undefined;
  return { slug, repositoryId, commitSha, generatedAt, entityCount };
}

/**
 * Enumerates `fixtures/scan/<slug>/snapshot.json` directories and builds a fresh,
 * deterministic manifest. The root trio (`fixtures/scan/{snapshot,view,story}.json`,
 * the Okie self-scan) is intentionally NOT listed — it is always reachable via
 * `?fixture=scan` with no slug; the manifest enumerates only the per-repo slots that
 * `?fixture=scan:<slug>` selects. Missing/invalid snapshots are skipped, never fatal.
 */
export function regenerateScanManifest(scanRoot: string): ScanManifest {
  const entries: ScanManifestEntry[] = [];
  let dirents;
  try {
    dirents = readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    return buildScanManifest(entries);
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const snapshotPath = join(scanRoot, dirent.name, "snapshot.json");
    if (!existsSync(snapshotPath)) continue;
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    } catch {
      continue;
    }
    const entry = manifestEntryFromSnapshot(dirent.name, snapshot);
    if (entry) entries.push(entry);
  }
  return buildScanManifest(entries);
}
