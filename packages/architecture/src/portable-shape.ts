import type {
  ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, ArchitectureView,
  CoverageLineRange, Evidence, Exposure, NodeLayout, SourceExcerpt, SourceRef, UntestedBehaviour,
} from './model.js';

type Shape = (value: unknown, path: string) => void;
type Fields<T> = { [K in keyof T]-?: Shape };

function invalid(path: string, expected: string): never {
  throw new Error(`${path}: expected ${expected}`);
}

const string: Shape = (value, path) => { if (typeof value !== 'string') invalid(path, 'a string'); };
const identifier: Shape = (value, path) => {
  string(value, path);
  if (!(value as string).trim()) invalid(path, 'a non-blank string');
};
const number: Shape = (value, path) => { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'a finite number'); };
const line: Shape = (value, path) => { if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(path, 'a positive integer'); };
const boolean: Shape = (value, path) => { if (typeof value !== 'boolean') invalid(path, 'a boolean'); };
const optional = (shape: Shape): Shape => (value, path) => { if (value !== undefined) shape(value, path); };
const choice = (values: readonly (string | number)[]): Shape => (value, path) => {
  if (!values.some(candidate => candidate === value)) invalid(path, values.map(String).join(' or '));
};
const list = (shape: Shape): Shape => (value, path) => {
  if (!Array.isArray(value)) invalid(path, 'an array');
  value.forEach((item, index) => shape(item, `${path}[${index}]`));
};
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'an object');
  return value as Record<string, unknown>;
}
const object = (fields: Record<string, Shape>): Shape => (value, path) => {
  const input = record(value, path);
  for (const [key, shape] of Object.entries(fields)) shape(input[key], `${path}.${key}`);
};
const dictionary = (shape: Shape): Shape => (value, path) => {
  for (const [key, item] of Object.entries(record(value, path))) shape(item, `${path}.${key}`);
};

const sourceRef = object({
  path: identifier, commitSha: identifier, symbol: optional(identifier),
  startLine: optional(line), endLine: optional(line),
} satisfies Fields<SourceRef>);
const evidence = object({ source: sourceRef, reason: optional(string) } satisfies Fields<Evidence>);
const exposure = object({
  kind: choice(['moduleExport', 'publicApi', 'entryPoint']), evidence,
} satisfies Fields<Exposure>);
const sourceExcerpt = object({
  path: identifier, symbol: optional(identifier), language: choice(['typescript', 'tsx', 'javascript', 'rust']),
  startLine: line, endLine: line, highlightLine: line, frozenRevision: identifier, lines: list(string), text: string,
} satisfies Fields<SourceExcerpt>);
const coverageRange = object({ startLine: line, endLine: line } satisfies Fields<CoverageLineRange>);
const untestedBehaviour = object({ startLine: line, endLine: line, behaviour: identifier } satisfies Fields<UntestedBehaviour>);

const entity = object({
  id: identifier, lineageId: optional(identifier),
  kind: choice(['person', 'softwareSystem', 'container', 'component', 'code', 'externalSystem', 'dataStore', 'queue', 'boundary']),
  parentId: optional(identifier), name: identifier, responsibility: optional(string),
  technology: optional(list(string)), tags: optional(list(string)), exposure: optional(list(exposure)),
  owners: optional(list(identifier)), cyclomaticComplexity: optional(number), coverageFileHitRate: optional(number),
  coverageUntestedRanges: optional(list(coverageRange)), untestedBehaviours: optional(list(untestedBehaviour)),
  sourceRefs: list(sourceRef), sourceExcerpts: optional(list(sourceExcerpt)),
  confidence: optional(number), fingerprint: optional(string),
} satisfies Fields<ArchitectureEntity>);
const relation = object({
  id: identifier, lineageId: optional(identifier), fingerprint: optional(string), from: identifier, to: identifier,
  kind: choice(['uses', 'calls', 'reads', 'writes', 'publishes', 'subscribes', 'contains', 'dependsOn', 'returns', 'duplicates']),
  label: optional(string), technology: optional(string), optional: optional(boolean),
  evidence: list(evidence), confidence: optional(number),
} satisfies Fields<ArchitectureRelation>);
const snapshot = object({
  schemaVersion: choice([1]), id: identifier, repositoryId: identifier, commitSha: identifier, generatedAt: identifier,
  entities: list(entity), relations: list(relation),
} satisfies Fields<ArchitectureSnapshot>);
const nodeLayout = object({ x: number, y: number, width: number, height: number, locked: optional(boolean) } satisfies Fields<NodeLayout>);
const view = object({
  schemaVersion: choice([1]), id: identifier, snapshotId: identifier, name: identifier, rootEntityId: identifier,
  entityIds: list(identifier), relationIds: list(identifier),
  layout: object({ nodes: dictionary(nodeLayout), edges: optional(dictionary(object({ points: list(object({ x: number, y: number })) }))) }),
} satisfies Fields<ArchitectureView>);

/** Semantic validators assume typed models; check every field before calling them on imported JSON. */
export function validatePortableGraphShape(rawSnapshot: unknown, rawView: unknown): void {
  snapshot(rawSnapshot, 'snapshot');
  view(rawView, 'view');
}
