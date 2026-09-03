import {
  CYCLOMATIC_FLAG_THRESHOLD,
  type C4NotationCompletenessCode,
  type C4NotationCompletenessDiagnostic,
} from '@okie/architecture';

export { CYCLOMATIC_FLAG_THRESHOLD };

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

export type InspectorCyclomaticEntity = {
  cyclomaticComplexity?: number;
};

export type InspectorCyclomaticPresentation = {
  complexity: number;
  flagged: boolean;
};

/**
 * Observed McCabe cyclomatic complexity for a function-like L4 code entity.
 * Omit when absent (types, classes, constants, unscanned). Flag when `comp > 6`
 * (Complexity Kink ~6.5). McCabe 10 is not the product flag.
 */
export function inspectorCyclomatic(
  entity: InspectorCyclomaticEntity | undefined,
): InspectorCyclomaticPresentation | undefined {
  const value = entity?.cyclomaticComplexity;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return { complexity: value, flagged: value > CYCLOMATIC_FLAG_THRESHOLD };
}

export type InspectorDuplicateCounterpart = {
  id: string;
  name: string;
};

export type InspectorDuplicateRelation = {
  from: string;
  to: string;
  kind?: string;
};

export type InspectorDuplicateEntity = {
  id: string;
  name: string;
};

/**
 * Observed token/AST clone counterparts for an L4 code entity. Snapshot
 * `duplicates` edges only — invented ids never appear.
 */
export function inspectorDuplicates(
  selectedId: string | undefined,
  relations: readonly InspectorDuplicateRelation[],
  entities: readonly InspectorDuplicateEntity[],
): InspectorDuplicateCounterpart[] {
  if (!selectedId) return [];
  const names = new Map(entities.map(entity => [entity.id, entity.name]));
  const counterparts = new Map<string, string>();
  for (const relation of relations) {
    if (relation.kind !== 'duplicates') continue;
    const other = relation.from === selectedId
      ? relation.to
      : relation.to === selectedId
        ? relation.from
        : undefined;
    if (!other || other === selectedId || !names.has(other)) continue;
    counterparts.set(other, names.get(other)!);
  }
  return [...counterparts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, name]) => ({ id, name }));
}

/**
 * Completeness noise (missing descriptions, technology, labels) can number in
 * the thousands on a self-scan. Structural / invalid notation still has to
 * appear in Details — it is not sampled away with that noise.
 */
export const INSPECTOR_NOTATION_ADVISORY_SAMPLE = 5;

const INSPECTOR_NOTATION_ERROR_CODES: ReadonlySet<C4NotationCompletenessCode> = new Set([
  'diagram.type.unsupported',
  'diagram.scope.unknown',
  'diagram.scope.outside-view',
  'diagram.scope.incompatible',
  'element.type.unsupported',
  'relationship.direction.invalid',
]);

export type InspectorNotationTone = 'error' | 'advisory';

export type InspectorNotationDiagnosticRow = {
  code: C4NotationCompletenessCode;
  path: string;
  message: string;
  subjectId: string;
  tone: InspectorNotationTone;
};

export type InspectorNotationPresentation = {
  total: number;
  errors: InspectorNotationDiagnosticRow[];
  sample: InspectorNotationDiagnosticRow[];
  hiddenCount: number;
  ready: boolean;
};

export type InspectorNotationScope = {
  entityIds: ReadonlySet<string>;
  relationIds: ReadonlySet<string>;
};

export type InspectorNotationScopeInput = {
  selectedId: string;
  /** Entity ids in the current C4 band (canvas projection at this detail). */
  bandEntityIds: readonly string[];
  entities: readonly { id: string; parentId?: string }[];
  relations: readonly { id: string; from: string; to: string }[];
};

export type InspectorNotationPresentOptions = {
  sampleLimit?: number;
  /** When set, completeness count+sample belong to this selection / band — not the whole atlas. */
  scope?: InspectorNotationScope;
};

function notationRow(
  diagnostic: C4NotationCompletenessDiagnostic,
  tone: InspectorNotationTone,
): InspectorNotationDiagnosticRow {
  return {
    code: diagnostic.code,
    path: diagnostic.path,
    message: diagnostic.message,
    subjectId: diagnostic.subject.id,
    tone,
  };
}

function ancestorOrSelf(
  entity: { id: string; parentId?: string },
  ownerId: string,
  byId: Map<string, { id: string; parentId?: string }>,
): boolean {
  let current: { id: string; parentId?: string } | undefined = entity;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ownerId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function diagnosticInCompletenessScope(
  diagnostic: C4NotationCompletenessDiagnostic,
  scope: InspectorNotationScope,
): boolean {
  if (diagnostic.subject.kind === 'diagram') return true;
  if (diagnostic.subject.kind === 'element') return scope.entityIds.has(diagnostic.subject.id);
  return scope.relationIds.has(diagnostic.subject.id);
}

/**
 * Completeness subjects for inspector Details: the selected entity, plus
 * descendants that sit in the current C4 band (the honest diagram for that
 * selection). Relations that touch that set belong too. Root-system + code
 * band is still a large dump — CLA-59 sampling still applies — but L1 must
 * not attribute every code-file omission to the selected system.
 */
export function inspectorNotationScope(input: InspectorNotationScopeInput): InspectorNotationScope {
  const byId = new Map(input.entities.map(entity => [entity.id, entity]));
  const band = new Set(input.bandEntityIds);
  const entityIds = new Set<string>([input.selectedId]);
  for (const entity of input.entities) {
    if (!band.has(entity.id) || entity.id === input.selectedId) continue;
    if (ancestorOrSelf(entity, input.selectedId, byId)) entityIds.add(entity.id);
  }
  const relationIds = new Set<string>();
  for (const relation of input.relations) {
    if (entityIds.has(relation.from) || entityIds.has(relation.to)) relationIds.add(relation.id);
  }
  return { entityIds, relationIds };
}

/**
 * Count-with-sample for inspector Details. Completeness advisories are capped
 * and, when a scope is provided, counted only for that selection / C4 band.
 * Real notation errors are listed in full, keep input order, and stay unscoped.
 */
export function presentInspectorNotationDiagnostics(
  diagnostics: readonly C4NotationCompletenessDiagnostic[],
  options: InspectorNotationPresentOptions = {},
): InspectorNotationPresentation {
  const errors: InspectorNotationDiagnosticRow[] = [];
  const advisories: InspectorNotationDiagnosticRow[] = [];
  for (const diagnostic of diagnostics) {
    if (INSPECTOR_NOTATION_ERROR_CODES.has(diagnostic.code)) {
      errors.push(notationRow(diagnostic, 'error'));
      continue;
    }
    if (options.scope && !diagnosticInCompletenessScope(diagnostic, options.scope)) continue;
    advisories.push(notationRow(diagnostic, 'advisory'));
  }
  const limit = Math.max(0, options.sampleLimit ?? INSPECTOR_NOTATION_ADVISORY_SAMPLE);
  const sample = advisories.slice(0, limit);
  const total = errors.length + advisories.length;
  return {
    total,
    errors,
    sample,
    hiddenCount: Math.max(0, advisories.length - sample.length),
    ready: total === 0,
  };
}
