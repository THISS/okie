export const MIN_INSPECTOR_WIDTH = 360;
export const MAX_INSPECTOR_WIDTH = 520;
export const MAX_INSPECTOR_VIEWPORT_RATIO = .46;
export const DEFAULT_INSPECTOR_MIN_WIDTH = 376;
export const DEFAULT_INSPECTOR_MAX_WIDTH = 416;
export const DEFAULT_INSPECTOR_VIEWPORT_RATIO = .28;
export const COMPACT_INSPECTOR_BREAKPOINT = 1_060;

export function inspectorWidthRange(viewportWidth: number) {
  const safeViewport = Math.max(1, viewportWidth);
  return {
    min: MIN_INSPECTOR_WIDTH,
    max: Math.round(Math.max(
      MIN_INSPECTOR_WIDTH,
      Math.min(MAX_INSPECTOR_WIDTH, safeViewport * MAX_INSPECTOR_VIEWPORT_RATIO),
    )),
  };
}

export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const range = inspectorWidthRange(viewportWidth);
  return Math.round(Math.max(range.min, Math.min(range.max, width)));
}

export function defaultInspectorWidth(viewportWidth: number): number {
  if (viewportWidth <= COMPACT_INSPECTOR_BREAKPOINT) return MIN_INSPECTOR_WIDTH;
  return Math.round(Math.max(
    DEFAULT_INSPECTOR_MIN_WIDTH,
    Math.min(DEFAULT_INSPECTOR_MAX_WIDTH, viewportWidth * DEFAULT_INSPECTOR_VIEWPORT_RATIO),
  ));
}

export function inspectorWidthStorageKey(repositoryId: string): string {
  return `okie:inspector-width:${repositoryId}`;
}

export type InspectorTab = 'source' | 'details';
export type InspectorIntent = 'auto' | 'source' | 'details';

/** Minimal entity shape used to decide whether the inspector Source tab can open. */
export type InspectorSourceEntity = {
  detail?: string;
  sourceExcerpts?: readonly unknown[];
  sourceRefs?: readonly unknown[];
};

/**
 * Source is available when the selected subject is a code-detail entity with
 * frozen excerpts and/or source refs. Scanned L4 entities often carry refs
 * without a portable excerpt; the tab still opens and SourceViewer degrades.
 * Relations and entities with no source evidence keep Source disabled.
 */
export function inspectorCanShowSource(
  entity: InspectorSourceEntity,
  options: { pickedRelation?: boolean } = {},
): boolean {
  if (options.pickedRelation) return false;
  if (entity.detail !== 'code') return false;
  return Boolean(entity.sourceExcerpts?.length || entity.sourceRefs?.length);
}

export function inspectorTabForEntity(canShowSource: boolean, intent: InspectorIntent = 'auto'): InspectorTab {
  if (intent === 'details') return 'details';
  return canShowSource ? 'source' : 'details';
}

/**
 * Compile-time empty copy written onto scene entities when the snapshot has no
 * `responsibility`. Not an accepted enrichment summary — Details stays as-is.
 */
export const INSPECTOR_EMPTY_SUMMARY = 'No summary supplied.';

export type InspectorSummaryEntity = {
  responsibility?: string;
};

/**
 * Accepted section summaries land on `responsibility` after the enrichment gate
 * (CLA-24). Hand-authored golden copy uses the same field. Placeholder / blank
 * copy is not a summary: the inspector keeps current Details/Source only.
 * Failed or skipped enrichment never blanks those tabs — it just omits this text.
 */
export function inspectorAcceptedSummary(
  entity: InspectorSummaryEntity | undefined,
): string | undefined {
  const text = entity?.responsibility?.trim();
  if (!text || text === INSPECTOR_EMPTY_SUMMARY) return undefined;
  return text;
}

export type InspectorOwnersEntity = {
  owners?: readonly string[];
};

/**
 * Observed CODEOWNERS (or equivalent) path owners. Empty when the repo has none —
 * the inspector omits the section rather than inventing owners.
 */
export function inspectorPathOwners(entity: InspectorOwnersEntity | undefined): string[] {
  return [...new Set((entity?.owners ?? []).map(owner => owner.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}
