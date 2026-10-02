import { describe, expect, it } from 'vitest';
import type { SceneEntity } from '../renderer/types';
import { decodeSearchCorpus, fallbackSearch, prepareSearchCorpus, querySearchRows } from './searchEngine';
import { searchArchitectureEntities } from '../searchSuggestions';

describe('worker search corpus', () => {
  it('preserves legacy ordering, kind/source matching, whitespace, Unicode and limit', async () => {
    const entities = Array.from({ length: 600 }, (_, i) => ({ id: String(i), name: `ÉCHO ${i}`, kind: 'component', responsibility: 'Loads data', source: i % 2 ? 'folder/file.ts' : undefined })) as SceneEntity[];
    const buffers = await prepareSearchCorpus(entities, () => false, async () => {});
    expect(buffers).toHaveLength(3);
    const rows = decodeSearchCorpus(buffers!);
    expect(new TextDecoder().decode(buffers![0])).toContain('ÉCHO');
    for (const query of [' écho ', 'component', 'file.ts', 'loads data', '', 'missing']) {
      const expected = searchArchitectureEntities({ entities }, query).map(entity => entity.id);
      expect(await querySearchRows(rows, query, 7, () => false, async () => {})).toEqual(expected);
      expect(await fallbackSearch(entities, query, 7, () => false)).toEqual(expected);
    }
    expect(rows[0]).toHaveLength(2);
  });
  it('cancels both corpus preparation and queries at yielding boundaries', async () => {
    let cancelled = false;
    const entities = Array.from({ length: 600 }, (_, i) => ({ id: String(i), name: 'item', kind: 'component', responsibility: '' })) as SceneEntity[];
    expect(await prepareSearchCorpus(entities, () => cancelled, async () => { cancelled = true; })).toBeNull();
    cancelled = false;
    expect(await querySearchRows(entities.map(entity => [entity.id, 'item']), 'missing', 7, () => cancelled, async () => { cancelled = true; })).toBeNull();
  });
});
