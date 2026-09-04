import type { ArchitectureEntity, ArchitectureSnapshot, CoverageLineRange } from "@okie/architecture";

/**
 * Conventional lcov.info locations under the scan root. First existing file
 * wins. `--lcov` overrides this list. Missing files are not an error.
 */
export const LCOV_CANDIDATE_PATHS = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage/lcov/lcov.info",
] as const;

/** Cap untested ranges per code entity so the inspector stays bounded. */
export const MAX_COVERAGE_UNTESTED_RANGES = 32;

export interface LcovFileRecord {
  path: string;
  /** One-based instrumented line → hit count (merged across records). */
  hitsByLine: Map<number, number>;
  linesFound: number;
  linesHit: number;
}

export interface LcovSidecar {
  path: string;
  files: ReadonlyMap<string, LcovFileRecord>;
}

export interface EntityCoverageOverlay {
  fileHitRate: number;
  untestedRanges?: CoverageLineRange[];
}

/** First existing conventional lcov sidecar. Missing files are not an error. */
export function readLcov(
  readFile: (repoRelativePath: string) => string,
): LcovSidecar | undefined {
  for (const path of LCOV_CANDIDATE_PATHS) {
    let text: string;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    return { path, files: parseLcov(text) };
  }
  return undefined;
}

/**
 * Parse lcov.info bytes into per-file instrumented-line maps. Duplicate `SF:`
 * records for the same path merge by adding hit counts. `LF`/`LH` are taken
 * from the record when present; otherwise they are derived from `DA` rows.
 */
export function parseLcov(text: string): Map<string, LcovFileRecord> {
  const files = new Map<string, LcovFileRecord>();
  let currentPath: string | undefined;
  let hitsByLine = new Map<number, number>();
  let linesFound: number | undefined;
  let linesHit: number | undefined;

  const flush = (): void => {
    if (!currentPath) return;
    const derivedFound = hitsByLine.size;
    const derivedHit = [...hitsByLine.values()].filter(hits => hits > 0).length;
    const found = linesFound !== undefined ? linesFound : derivedFound;
    const hit = linesHit !== undefined ? Math.min(linesHit, found) : derivedHit;
    const existing = files.get(currentPath);
    if (!existing) {
      files.set(currentPath, {
        path: currentPath,
        hitsByLine,
        linesFound: found,
        linesHit: hit,
      });
    } else {
      for (const [line, hits] of hitsByLine) {
        existing.hitsByLine.set(line, (existing.hitsByLine.get(line) ?? 0) + hits);
      }
      const mergedFound = existing.hitsByLine.size;
      const mergedHit = [...existing.hitsByLine.values()].filter(count => count > 0).length;
      existing.linesFound = Math.max(existing.linesFound, found, mergedFound);
      existing.linesHit = Math.max(existing.linesHit, hit, mergedHit);
    }
    currentPath = undefined;
    hitsByLine = new Map();
    linesFound = undefined;
    linesHit = undefined;
  };

  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "end_of_record") {
      flush();
      continue;
    }
    if (line.startsWith("SF:")) {
      flush();
      const sourceFile = normalizeLcovSourcePath(line.slice(3));
      currentPath = sourceFile || undefined;
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("DA:")) {
      const parsed = parseDaLine(line.slice(3));
      if (!parsed) continue;
      hitsByLine.set(parsed.line, (hitsByLine.get(parsed.line) ?? 0) + parsed.hits);
      continue;
    }
    if (line.startsWith("LF:")) {
      const value = parseNonNegativeInt(line.slice(3));
      if (value !== undefined) linesFound = value;
      continue;
    }
    if (line.startsWith("LH:")) {
      const value = parseNonNegativeInt(line.slice(3));
      if (value !== undefined) linesHit = value;
    }
  }
  flush();
  return files;
}

/** Repo-relative SF: path, or empty when the record is unusable. */
export function normalizeLcovSourcePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  if (path.startsWith("file:")) {
    path = path.replace(/^file:\/\//i, "");
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  path = path.replace(/^[A-Za-z]:/, "");
  while (path.startsWith("./")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  return path;
}

/**
 * Match an lcov SF: path onto a known repo-relative source path. Absolute CI
 * prefixes are accepted when they end with a known path. Unmatched files stay
 * off the overlay — they never invent 0%.
 */
export function matchLcovSourcePath(
  sourceFile: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  const normalized = normalizeLcovSourcePath(sourceFile);
  if (!normalized) return undefined;
  if (knownPaths.has(normalized)) return normalized;
  let best: string | undefined;
  for (const path of knownPaths) {
    if (normalized === path || normalized.endsWith(`/${path}`)) {
      if (!best || path.length > best.length) best = path;
    }
  }
  return best;
}

export function fileHitRate(record: LcovFileRecord): number | undefined {
  if (record.linesFound <= 0) return undefined;
  const hit = Math.min(Math.max(0, record.linesHit), record.linesFound);
  return hit / record.linesFound;
}

export function untestedRangesFromHits(
  hitsByLine: ReadonlyMap<number, number>,
  startLine: number,
  endLine: number,
): CoverageLineRange[] {
  const lines = [...hitsByLine.entries()]
    .filter(([line, hits]) => line >= startLine && line <= endLine && hits === 0)
    .map(([line]) => line)
    .sort((left, right) => left - right);
  const ranges: CoverageLineRange[] = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last && line === last.endLine + 1) {
      last.endLine = line;
      continue;
    }
    ranges.push({ startLine: line, endLine: line });
    if (ranges.length >= MAX_COVERAGE_UNTESTED_RANGES) break;
  }
  return ranges;
}

export function coverageOverlayForEntity(
  entity: ArchitectureEntity,
  files: ReadonlyMap<string, LcovFileRecord>,
): EntityCoverageOverlay | undefined {
  if (entity.kind !== "code") return undefined;
  const ref = entity.sourceRefs[0];
  if (!ref?.path) return undefined;
  const record = files.get(ref.path);
  if (!record) return undefined;
  const rate = fileHitRate(record);
  if (rate === undefined) return undefined;
  const startLine = ref.startLine ?? 1;
  const endLine = ref.endLine ?? startLine;
  const ranges = untestedRangesFromHits(record.hitsByLine, startLine, endLine);
  return {
    fileHitRate: rate,
    ...(ranges.length ? { untestedRanges: ranges } : {}),
  };
}

/**
 * Overlay observed lcov gaps onto existing code entities. No new C4 nodes.
 * Extraction documents stay coverage-free. No sidecar → omit coverage and
 * still keep complexity + clones. Files absent from the report stay omitted
 * rather than inventing 0%.
 */
export function attachCoverage(
  snapshot: ArchitectureSnapshot,
  sidecar: LcovSidecar | undefined,
): ArchitectureSnapshot {
  if (!sidecar || sidecar.files.size === 0) {
    return snapshot.entities.every(entity =>
      entity.coverageFileHitRate === undefined && entity.coverageUntestedRanges === undefined
    )
      ? snapshot
      : {
        ...snapshot,
        entities: snapshot.entities.map(clearCoverage),
      };
  }

  const knownPaths = new Set<string>();
  for (const entity of snapshot.entities) {
    for (const ref of entity.sourceRefs) {
      if (ref.path) knownPaths.add(ref.path);
    }
  }
  const files = resolveSidecarFiles(sidecar, knownPaths);

  return {
    ...snapshot,
    entities: snapshot.entities.map(entity => {
      const cleared = clearCoverage(entity);
      const overlay = coverageOverlayForEntity(cleared, files);
      if (!overlay) return cleared;
      return {
        ...cleared,
        coverageFileHitRate: overlay.fileHitRate,
        ...(overlay.untestedRanges?.length ? { coverageUntestedRanges: overlay.untestedRanges } : {}),
      };
    }),
  };
}

function clearCoverage(entity: ArchitectureEntity): ArchitectureEntity {
  if (entity.coverageFileHitRate === undefined && entity.coverageUntestedRanges === undefined) return entity;
  const rest = { ...entity };
  delete rest.coverageFileHitRate;
  delete rest.coverageUntestedRanges;
  return rest;
}

function resolveSidecarFiles(
  sidecar: LcovSidecar,
  knownPaths: ReadonlySet<string>,
): Map<string, LcovFileRecord> {
  const resolved = new Map<string, LcovFileRecord>();
  for (const [sf, record] of sidecar.files) {
    const matched = matchLcovSourcePath(sf, knownPaths);
    if (!matched) continue;
    resolved.set(matched, { ...record, path: matched, hitsByLine: record.hitsByLine });
  }
  return resolved;
}

function parseDaLine(payload: string): { line: number; hits: number } | undefined {
  const [linePart, hitsPart] = payload.split(",", 2);
  const line = parsePositiveInt(linePart);
  const hits = parseNonNegativeInt(hitsPart);
  if (line === undefined || hits === undefined) return undefined;
  return { line, hits };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}
