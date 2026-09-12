import type { ArchitectureSnapshot, ArchitectureStory, ArchitectureView } from './model.js';
import { validateSnapshot, validateStoryDocument, validateView } from './validation.js';
import { validatePortableGraphShape } from './portable-shape.js';

/** A portable semantic artifact. Renderer scenes are compiled by the matching viewer. */
export interface PortableAtlas {
  format: 'okie-atlas';
  version: 1;
  repository: { commitSha: string; treeHash: string; url?: string };
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  story: ArchitectureStory;
  stories: ArchitectureStory[];
  analysis: {
    mode: 'full' | 'quick';
    adapters: { language: string; tool: string; version: string; coverage: 'semantic' | 'syntax' | 'unavailable'; limitations: string[] }[];
  };
  /** Optional full files at repository.commitSha; snippets remain in snapshot entities. */
  sources?: { path: string; text: string }[];
}

export const PORTABLE_ATLAS_MAX_BYTES = 128 * 1024 * 1024;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export function portableSourcePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !/[\\\u0000-\u001f:]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Reject incompatible or malformed imports before persistence or compilation. */
export function parsePortableAtlas(text: string): PortableAtlas {
  if (new TextEncoder().encode(text).byteLength > PORTABLE_ATLAS_MAX_BYTES) throw new Error('Scan bundle exceeds the 128 MiB import limit.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Scan bundle is not valid JSON.'); }
  if (!record(raw) || raw.format !== 'okie-atlas' || raw.version !== 1) throw new Error('Unsupported scan bundle. Expected okie-atlas version 1.');
  if (!record(raw.repository) || typeof raw.repository.commitSha !== 'string' || !commitPattern.test(raw.repository.commitSha)
    || typeof raw.repository.treeHash !== 'string' || !commitPattern.test(raw.repository.treeHash)) throw new Error('Scan bundle must identify a committed source revision and tree.');
  if (raw.repository.url !== undefined) {
    if (typeof raw.repository.url !== 'string') throw new Error('Repository URL must be an HTTPS URL.');
    const url = new URL(raw.repository.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Repository URL must be an HTTPS URL without credentials.');
  }
  if (!record(raw.snapshot) || !record(raw.view) || !record(raw.story) || !Array.isArray(raw.stories)) throw new Error('Scan bundle is missing snapshot, view or story data.');
  if (raw.snapshot.commitSha !== raw.repository.commitSha) throw new Error('Snapshot revision does not match the bundled repository.');
  if (!record(raw.analysis) || typeof raw.analysis.mode !== 'string' || !['full', 'quick'].includes(raw.analysis.mode) || !Array.isArray(raw.analysis.adapters)) throw new Error('Scan bundle must report its analysis coverage.');
  for (const adapter of raw.analysis.adapters) {
    if (!record(adapter) || ![adapter.language, adapter.tool, adapter.version].every(value => typeof value === 'string' && value.length > 0)
      || typeof adapter.coverage !== 'string' || !['semantic', 'syntax', 'unavailable'].includes(adapter.coverage) || !strings(adapter.limitations)) throw new Error('Invalid analyzer coverage entry.');
  }
  const bundle = raw as unknown as PortableAtlas;
  try {
    validatePortableGraphShape(raw.snapshot, raw.view);
    const issues = [...validateSnapshot(bundle.snapshot), ...validateView(bundle.snapshot, bundle.view),
      ...[bundle.story, ...bundle.stories].flatMap(story => validateStoryDocument(bundle.snapshot, bundle.view, story))];
    if (issues.length) throw new Error(issues.slice(0, 5).map(issue => `${issue.path}: ${issue.message}`).join('; '));
    const refs = [...bundle.snapshot.entities.flatMap(entity => [...entity.sourceRefs, ...(entity.exposure ?? []).map(exposure => exposure.evidence.source)]),
      ...bundle.snapshot.relations.flatMap(relation => relation.evidence.map(evidence => evidence.source))];
    if (refs.some(ref => ref.commitSha !== bundle.repository.commitSha)) throw new Error('Source evidence revision differs from the bundle revision.');
    if (refs.some(ref => !portableSourcePath(ref.path) || (ref.endLine !== undefined && ref.endLine < (ref.startLine ?? 1)))) throw new Error('Source evidence requires a repository-relative path and an ordered line range.');
    if (bundle.snapshot.entities.some(entity => entity.sourceExcerpts?.some(excerpt => excerpt.frozenRevision !== bundle.repository.commitSha))) throw new Error('Source excerpt revision differs from the bundle revision.');
  } catch (error) { throw new Error(`Invalid scan graph: ${error instanceof Error ? error.message : String(error)}`); }
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) throw new Error('Bundled sources must be a list of files.');
    const paths = new Set<string>();
    for (const file of raw.sources) {
      if (!record(file) || !portableSourcePath(file.path) || typeof file.text !== 'string' || paths.has(file.path)) throw new Error('Bundled source paths must be unique repository-relative files.');
      paths.add(file.path);
    }
  }
  return bundle;
}

export function serializePortableAtlas(bundle: PortableAtlas): string {
  const text = JSON.stringify(bundle) + '\n';
  parsePortableAtlas(text);
  return text;
}
