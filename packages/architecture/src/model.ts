export const ARCHITECTURE_SCHEMA_VERSION = 1 as const;

/**
 * Product flag for observed McCabe cyclomatic complexity (Complexity Kink ~6.5).
 * Flag when `cyclomaticComplexity > CYCLOMATIC_FLAG_THRESHOLD`. McCabe 10 is the
 * human-era lint bar — documented only, not the product flag.
 */
export const CYCLOMATIC_FLAG_THRESHOLD = 6;

export type EntityId = string;
export type RelationId = string;
export type SnapshotId = string;
export type ViewId = string;
export type StoryId = string;

export type EntityKind =
  | "person"
  | "softwareSystem"
  | "container"
  | "component"
  | "code"
  | "externalSystem"
  | "dataStore"
  | "queue"
  | "boundary";

export type RelationKind =
  | "uses"
  | "calls"
  | "reads"
  | "writes"
  | "publishes"
  | "subscribes"
  | "contains"
  | "dependsOn"
  | "returns"
  | "duplicates";

export interface SourceRef {
  path: string;
  commitSha: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export const SOURCE_EXCERPT_LIMITS = {
  maxPathCharacters: 512,
  maxSymbolCharacters: 256,
  maxLines: 12,
  maxLineCharacters: 512,
  maxTextCharacters: 4096,
} as const;

export type SourceLanguage = "typescript" | "tsx" | "javascript" | "rust";

/** Immutable, portable source content captured when a snapshot is built. */
export interface SourceExcerpt {
  path: string;
  symbol?: string;
  language: SourceLanguage;
  /** One-based inclusive source range. */
  startLine: number;
  endLine: number;
  /** One-based source line containing the curated anchor. */
  highlightLine: number;
  frozenRevision: string;
  lines: string[];
  /** Must exactly equal lines.join("\n"). */
  text: string;
}

export interface Evidence {
  source: SourceRef;
  reason?: string;
}

export interface ArchitectureEntity {
  id: EntityId;
  /** Stable semantic identity used to reconcile this entity across immutable snapshots. */
  lineageId?: string;
  kind: EntityKind;
  parentId?: EntityId;
  name: string;
  responsibility?: string;
  technology?: string[];
  tags?: string[];
  /**
   * Observed CODEOWNERS (or equivalent path owners) for this entity's files.
   * Scan-time overlay — never ArchitectureExtraction input. Omit when empty.
   */
  owners?: string[];
  /**
   * Observed McCabe cyclomatic complexity for a function-like L4 code entity.
   * Scan-time overlay — never ArchitectureExtraction input. Omit when the
   * declaration has no executable body (types, interfaces, classes, constants).
   */
  cyclomaticComplexity?: number;
  sourceRefs: SourceRef[];
  sourceExcerpts?: SourceExcerpt[];
  confidence?: number;
  fingerprint?: string;
}

export interface ArchitectureRelation {
  id: RelationId;
  /** Stable semantic identity used to reconcile this relation across immutable snapshots. */
  lineageId?: string;
  fingerprint?: string;
  from: EntityId;
  to: EntityId;
  kind: RelationKind;
  label?: string;
  technology?: string;
  optional?: boolean;
  evidence: Evidence[];
  confidence?: number;
}

export interface ArchitectureSnapshot {
  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;
  id: SnapshotId;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  entities: ArchitectureEntity[];
  relations: ArchitectureRelation[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface NodeLayout extends Rect {
  locked?: boolean;
}

export interface EdgeLayout {
  points: Point[];
}

export interface ArchitectureView {
  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;
  id: ViewId;
  snapshotId: SnapshotId;
  name: string;
  rootEntityId: EntityId;
  entityIds: EntityId[];
  relationIds: RelationId[];
  layout: {
    nodes: Record<EntityId, NodeLayout>;
    edges?: Record<RelationId, EdgeLayout>;
  };
}

export type StoryDetail = "context" | "container" | "component" | "code";

export const STORY_AUTHORING_LIMITS = {
  maxTitleCharacters: 160,
  maxStepTitleCharacters: 120,
  maxNarrationCharacters: 1_200,
  maxSteps: 12,
  maxFocusEntitiesPerStep: 8,
  maxTraceRelationsPerStep: 16,
  maxSourceRefsPerStep: 16,
  // Ceiling for an authored narration hold; mirrors the scene compiler's
  // `maximumNarrationHoldMs` in packages/scene-compiler/src/compile-story.ts (keep in sync).
  maxStepDurationMs: 12_000,
} as const;

export interface StoryStep {
  id: string;
  title: string;
  focusEntityIds: EntityId[];
  traceRelationIds?: RelationId[];
  reveal?: StoryDetail;
  narration: string;
  sourceRefs?: SourceRef[];
  /** Narration hold duration after arrival. Camera-flight timing is derived by the host. */
  durationMs?: number;
}

export interface ArchitectureStory {
  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;
  id: StoryId;
  snapshotId: SnapshotId;
  viewId: ViewId;
  title: string;
  steps: StoryStep[];
}

/** User intent is stored separately so a scan cannot erase corrections. */
export interface ArchitectureOverrides {
  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;
  repositoryId: string;
  entityPatches: Record<EntityId, Partial<Pick<ArchitectureEntity, "name" | "responsibility" | "parentId" | "tags">>>;
  hiddenEntityIds: EntityId[];
  lockedLayout: Record<ViewId, Record<EntityId, NodeLayout>>;
}
