import type { ArchitectureSnapshot, SourceExcerpt } from '@okie/architecture';
import type { ExplanationEvidence } from './explanationModel';

type Match = { excerpt: SourceExcerpt; exact: boolean };

/** Distance from a line to an excerpt's range (0 when inside). */
const distance = (line: number, excerpt: SourceExcerpt) => line < excerpt.startLine ? excerpt.startLine - line : line > excerpt.endLine ? line - excerpt.endLine : 0;

function matching(excerpts: readonly SourceExcerpt[] | undefined, evidence: ExplanationEvidence): Match | undefined {
  const { path, startLine } = evidence;
  const samePath = (excerpts ?? []).filter(excerpt => !path || excerpt.path === path);
  if (!samePath.length) return undefined;
  if (startLine === undefined) return { excerpt: samePath[0]!, exact: true };
  const inside = samePath.find(excerpt => distance(startLine, excerpt) === 0);
  if (inside) return { excerpt: { ...inside, highlightLine: startLine }, exact: true };
  // The cited line was not captured: open the nearest captured excerpt of that file and say so.
  const nearest = samePath.reduce((best, excerpt) => distance(startLine, excerpt) < distance(startLine, best) ? excerpt : best);
  return { excerpt: nearest, exact: false };
}

/** `exact: false` means the cited line lies outside every captured excerpt and the nearest one is shown. */
export type ExplanationExcerpt = { entityId: string; excerpt: SourceExcerpt; exact: boolean };

/**
 * The frozen excerpt an explanation evidence row points at: the cited entity's own
 * excerpts first (loaded on demand), then any resident excerpt of the same file.
 * Undefined when the atlas holds no source for it — the caller says so instead.
 */
export async function resolveExplanationExcerpt(
  snapshot: ArchitectureSnapshot,
  evidence: ExplanationEvidence,
  ensureExcerpts?: (entityId: string) => Promise<readonly SourceExcerpt[] | undefined> | undefined,
): Promise<ExplanationExcerpt | undefined> {
  let nearest: ExplanationExcerpt | undefined;
  const cited = evidence.entityId ? snapshot.entities.find(entity => entity.id === evidence.entityId) : undefined;
  if (cited) {
    const loaded = cited.sourceExcerpts?.length ? cited.sourceExcerpts : await Promise.resolve(ensureExcerpts?.(cited.id)).catch(() => undefined);
    const found = matching(loaded, evidence);
    if (found?.exact || !evidence.path) return found && { entityId: cited.id, ...found };
    nearest = found && { entityId: cited.id, ...found };
  }
  if (!evidence.path) return undefined;
  // Another resident excerpt that contains the cited line beats a nearest-only match.
  for (const entity of snapshot.entities) {
    const found = matching(entity.sourceExcerpts, evidence);
    if (found?.exact) return { entityId: entity.id, ...found };
    if (found && !nearest) nearest = { entityId: entity.id, ...found };
  }
  return nearest;
}
