import type { SceneEntity } from '../renderer/types';

export type SearchTimingMetric = 'searchStartup' | 'searchPrepare' | 'searchIndex' | 'searchQuery' | 'searchRoundTrip' | 'searchFallback';
export type SearchTiming = (metric: SearchTimingMetric, durationMs: number) => void;
export type SearchRow = readonly [id: string, text: string];
export const yieldSearch = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const rawSearchText = (entity: SceneEntity) => `${entity.name} ${entity.kind} ${entity.responsibility} ${entity.source ?? ''}`;
export const searchText = (entity: SceneEntity) => rawSearchText(entity).toLowerCase();

/** Decode and normalize in the worker; main-thread preparation only packs original fields. */
export function decodeSearchCorpus(buffers: readonly ArrayBuffer[]): SearchRow[] {
  const decoder = new TextDecoder();
  return buffers.flatMap(buffer => (JSON.parse(decoder.decode(buffer)) as SearchRow[])
    .map(([id, text]) => [id, text.toLowerCase()] as const));
}

/** Build only the searchable corpus; never serialize geometry, evidence or the scene. */
export async function prepareSearchCorpus(entities: readonly SceneEntity[], cancelled: () => boolean, yieldWork = yieldSearch): Promise<ArrayBuffer[] | null> {
  let rows: SearchRow[] = [];
  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < entities.length; i++) {
    if (cancelled()) return null;
    rows.push([entities[i].id, rawSearchText(entities[i])]);
    if (i % 256 === 255) {
      buffers.push(new TextEncoder().encode(JSON.stringify(rows)).buffer as ArrayBuffer);
      rows = [];
      await yieldWork();
    }
  }
  if (cancelled()) return null;
  if (rows.length) buffers.push(new TextEncoder().encode(JSON.stringify(rows)).buffer as ArrayBuffer);
  return buffers;
}

/** Scene order and exact legacy substring semantics, with cooperative cancellation. */
export async function querySearchRows(rows: readonly SearchRow[], query: string, limit: number, cancelled: () => boolean, yieldWork = yieldSearch): Promise<string[] | null> {
  const normalized = query.trim().toLowerCase();
  if (!normalized || limit <= 0) return [];
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (cancelled()) return null;
    if (rows[i][1].includes(normalized)) {
      ids.push(rows[i][0]);
      if (ids.length >= limit) return ids;
    }
    if (i % 256 === 255) await yieldWork();
  }
  return cancelled() ? null : ids;
}

export async function fallbackSearch(entities: readonly SceneEntity[], query: string, limit: number, cancelled: () => boolean): Promise<string[] | null> {
  const normalized = query.trim().toLowerCase();
  if (!normalized || limit <= 0) return [];
  const ids: string[] = [];
  for (let i = 0; i < entities.length; i++) {
    if (cancelled()) return null;
    if (searchText(entities[i]).includes(normalized)) {
      ids.push(entities[i].id);
      if (ids.length >= limit) return ids;
    }
    if (i % 256 === 255) await yieldSearch();
  }
  return cancelled() ? null : ids;
}
