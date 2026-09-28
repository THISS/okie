import { describe, expect, it } from 'vitest';
import { BLOCK_CAPS, NEUTRAL_RELATIONSHIP, validateBlocks, type BlockValidationContext } from './blockModel';

const names = new Map([['container:web', 'Web'], ['container:db', 'Database']]);
const observed: BlockValidationContext = { source: 'observed', entityName: id => names.get(id) };
const enrichment: BlockValidationContext = { source: 'enrichment', entityName: id => names.get(id) };

describe('validateBlocks: shape and provenance', () => {
  it('stamps provenance from the source, ignoring any provenance in the input', () => {
    const { blocks, dropped } = validateBlocks([{ id: 'enrichment:summary', type: 'markdown', text: 'Hello', provenance: 'observed' }], enrichment);
    expect(dropped).toEqual([]);
    expect(blocks).toEqual([{ id: 'enrichment:summary', type: 'markdown', text: 'Hello', provenance: 'enrichment' }]);
  });
  it('drops structurally invalid blocks with a reason instead of rejecting the whole list', () => {
    const { blocks, dropped } = validateBlocks([
      { id: 'enrichment:a', type: 'markdown', text: 'Kept' },
      { id: 'enrichment:b', type: 'script', text: 'alert(1)' },
      { id: 'enrichment:a', type: 'markdown', text: 'Duplicate' },
      { id: 'Bad Id', type: 'markdown', text: 'x' },
      null,
      'text',
      { id: 'enrichment:c', type: 'keyPoints', title: 'T', items: [] },
      { id: 'enrichment:d', type: 'keyPoints', title: 'T', items: 'nope' },
    ], enrichment);
    expect(blocks.map(block => block.id)).toEqual(['enrichment:a']);
    expect(dropped).toEqual([
      { id: 'enrichment:b', type: 'script', reason: 'unknown block type' },
      { id: 'enrichment:a', type: 'markdown', reason: 'duplicate block id' },
      { id: 'Bad Id', type: 'markdown', reason: 'block id is missing or malformed' },
      { reason: 'block is not an object' },
      { reason: 'block is not an object' },
      { id: 'enrichment:c', type: 'keyPoints', reason: 'items is empty' },
      { id: 'enrichment:d', type: 'keyPoints', reason: 'items is not a list' },
    ]);
  });
  it('treats a non-array as one dropped note and absence as nothing', () => {
    expect(validateBlocks({ id: 'x' }, observed)).toEqual({ blocks: [], dropped: [{ reason: 'block list is not an array' }], trimmed: [] });
    expect(validateBlocks(undefined, observed)).toEqual({ blocks: [], dropped: [], trimmed: [] });
  });
  it('keeps each source inside its id namespace so model blocks cannot impersonate observed ones', () => {
    expect(validateBlocks([{ id: 'relations:dependencies', type: 'markdown', text: 'x' }], enrichment).dropped[0]?.reason).toBe('enrichment block id is outside its namespace');
    expect(validateBlocks([{ id: 'enrichment:x', type: 'markdown', text: 'x' }], observed).dropped[0]?.reason).toBe('observed block id is outside its namespace');
  });
  it('refuses observed-only types from enrichment', () => {
    const items = [{ id: 'container:web', relationship: 'uses' }];
    const { blocks, dropped } = validateBlocks([
      { id: 'enrichment:deps', type: 'relations', direction: 'dependencies', items },
      { id: 'enrichment:kids', type: 'children', items },
    ], enrichment);
    expect(blocks).toEqual([]);
    expect(dropped.map(item => item.reason)).toEqual(['relations blocks are observed facts only', 'children blocks are observed facts only']);
    expect(validateBlocks([{ id: 'relations:dependencies', type: 'relations', direction: 'dependencies', items }], observed).blocks).toHaveLength(1);
  });
});

describe('validateBlocks: references and unsafe props', () => {
  it('omits refs to unknown or repeated entities, dropping the block only when none remain', () => {
    expect(validateBlocks([{ id: 'enrichment:refs', type: 'nodeRefs', title: 'Related', refs: [{ id: 'container:ghost', reason: 'x' }] }], enrichment).dropped[0]?.reason).toBe('no ref names a known entity');
    const mixed = validateBlocks([{ id: 'nodeRefs:related', type: 'nodeRefs', title: 'Related', refs: [
      { id: 'container:web', reason: 'uses', label: 'Totally the database', href: 'https://evil.test' },
      { id: 'container:web', reason: 'again' }, { id: 'container:ghost', reason: 'x' },
    ] }], observed);
    expect(mixed.blocks[0]).toEqual({ id: 'nodeRefs:related', type: 'nodeRefs', provenance: 'observed', title: 'Related', refs: [{ id: 'container:web', reason: 'uses' }] });
    expect(mixed.trimmed).toEqual([{ id: 'nodeRefs:related', type: 'nodeRefs', omitted: 2, reasons: ['ref repeats an entity', 'ref names an unknown entity'] }]);
  });
  it('accepts only non-empty string names, so prototype keys and empty names are unknown', () => {
    const table: Record<string, unknown> = { 'container:web': 'Web', 'container:blank': '  ' };
    const lookup = { source: 'observed' as const, entityName: (id: string) => table[id] as string | undefined };
    const { blocks, trimmed } = validateBlocks([{ id: 'children', type: 'children', items: ['__proto__', 'toString', 'constructor', 'container:blank', 'container:web'].map(id => ({ id, relationship: 'component' })) }], lookup);
    expect(blocks[0]).toMatchObject({ items: [{ id: 'container:web' }] });
    expect(trimmed[0]?.omitted).toBe(4);
    expect(validateBlocks([{ id: 'nodeRefs:related', type: 'nodeRefs', title: 'R', refs: [{ id: '__proto__', reason: 'x' }] }], lookup).dropped[0]?.reason).toBe('no ref names a known entity');
  });
  it('ignores action, URL, HTML and handler props', () => {
    const { blocks } = validateBlocks([
      { id: 'enrichment:summary', type: 'markdown', text: 'Safe', html: '<img onerror=x>', href: 'javascript:alert(1)', onClick: 'x', action: { name: 'fetch', url: 'https://evil.test' }, import: './x.js' },
      { id: 'enrichment:diagram', type: 'mermaid', title: 'D', source: 'flowchart LR\n a --> b', url: 'https://evil.test' },
    ], enrichment);
    expect(blocks).toHaveLength(2);
    expect(JSON.stringify(blocks)).not.toMatch(/evil|onerror|javascript|onClick|import|action/u);
  });
  it('keeps only citations the atlas can resolve, stripping unsafe paths from known entities', () => {
    const { blocks, dropped, trimmed } = validateBlocks([{ id: 'enrichment:evidence', type: 'evidence', items: [
      { path: '../etc/passwd' }, { path: 'https://evil.test/a.ts' }, { entityId: 'container:ghost' }, 'junk',
      { entityId: 'container:web' }, { entityId: 'container:db', path: '../secret.ts', startLine: 3 },
      { path: 'src/a.ts', startLine: 4, endLine: 2 }, { path: 'src/b.ts', startLine: 3, endLine: 9, href: 'x' },
    ] }], enrichment);
    expect(dropped).toEqual([]);
    expect(blocks[0]).toMatchObject({ items: [{ entityId: 'container:web' }, { entityId: 'container:db' }, { path: 'src/a.ts', startLine: 4 }, { path: 'src/b.ts', startLine: 3, endLine: 9 }] });
    expect(JSON.stringify(blocks)).not.toContain('secret');
    expect(trimmed[0]?.omitted).toBe(4);
    expect(validateBlocks([{ id: 'enrichment:evidence', type: 'evidence', items: [{ entityId: 'container:ghost' }] }], enrichment).dropped[0]?.reason)
      .toBe('no evidence item cites a known entity or a safe source path');
  });
  it('requires exactly one known parent', () => {
    expect(validateBlocks([{ id: 'relations:parent', type: 'relations', direction: 'parent', items: [{ id: 'container:web', relationship: 'a' }, { id: 'container:db', relationship: 'b' }] }], observed).dropped[0]?.reason).toBe('a parent relation has exactly one item');
    expect(validateBlocks([{ id: 'relations:parent', type: 'relations', direction: 'sideways', items: [] }], observed).dropped[0]?.reason).toMatch(/direction/u);
  });
});

describe('validateBlocks: observed facts degrade instead of vanishing', () => {
  it('clips a long captured summary with an ellipsis', () => {
    const { blocks, dropped } = validateBlocks([{ id: 'summary', type: 'markdown', text: 'x'.repeat(BLOCK_CAPS.markdownChars + 50) }], observed);
    expect(dropped).toEqual([]);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toHaveLength(BLOCK_CAPS.markdownChars);
    expect(text.endsWith('…')).toBe(true);
  });
  it('truncates long lists, labels missing relationships neutrally and clips long ones', () => {
    names.set('container:many', 'Many');
    const items = Array.from({ length: BLOCK_CAPS.linkItems + 5 }, (_, index) => ({ id: 'container:many', relationship: index === 0 ? '' : index === 1 ? 'r'.repeat(200) : 'uses' }));
    const { blocks, trimmed } = validateBlocks([{ id: 'relations:dependencies', type: 'relations', direction: 'dependencies', items }], observed);
    const kept = (blocks[0] as { items: Array<{ relationship: string }> }).items;
    expect(kept).toHaveLength(BLOCK_CAPS.linkItems);
    expect(kept[0]?.relationship).toBe(NEUTRAL_RELATIONSHIP);
    expect(kept[1]?.relationship).toHaveLength(BLOCK_CAPS.relationshipChars);
    expect(trimmed).toEqual([{ id: 'relations:dependencies', type: 'relations', omitted: 5, reasons: [`items over the ${BLOCK_CAPS.linkItems}-item cap`] }]);
  });
  it('omits one unknown child without losing the rest', () => {
    const { blocks, trimmed } = validateBlocks([{ id: 'children', type: 'children', items: [{ id: 'container:ghost', relationship: 'component' }, { id: 'container:web', relationship: 'component' }] }], observed);
    expect(blocks[0]).toMatchObject({ items: [{ id: 'container:web' }] });
    expect(trimmed[0]).toMatchObject({ omitted: 1, reasons: ['item references an unknown entity'] });
  });
});

describe('validateBlocks: caps', () => {
  it('slices lists over their caps and clips long text, counting what was left out', () => {
    const { blocks, dropped, trimmed } = validateBlocks([
      { id: 'enrichment:summary', type: 'markdown', text: 'x'.repeat(BLOCK_CAPS.markdownChars + 1) },
      { id: 'enrichment:points', type: 'keyPoints', title: 'T', items: [...Array.from({ length: BLOCK_CAPS.keyPoints + 2 }, () => 'p'), 'q'.repeat(999)] },
      { id: 'enrichment:table', type: 'table', title: 'T', caption: 'c'.repeat(999), columns: ['a'], rows: Array.from({ length: BLOCK_CAPS.tableRows + 3 }, () => ['z'.repeat(999)]) },
      { id: 'enrichment:evidence', type: 'evidence', items: Array.from({ length: BLOCK_CAPS.evidence + 6 }, (_, index) => ({ path: `src/f${index}.ts` })) },
    ], enrichment);
    expect(dropped).toEqual([]);
    expect(blocks.map(block => block.id)).toEqual(['enrichment:summary', 'enrichment:points', 'enrichment:table', 'enrichment:evidence']);
    expect((blocks[1] as { items: string[] }).items).toHaveLength(BLOCK_CAPS.keyPoints);
    expect(blocks[2]).toMatchObject({ caption: `${'c'.repeat(BLOCK_CAPS.tableCaptionChars - 1)}…` });
    expect((blocks[2] as { rows: string[][] }).rows).toHaveLength(BLOCK_CAPS.tableRows);
    expect((blocks[2] as { rows: string[][] }).rows[0]?.[0]).toHaveLength(BLOCK_CAPS.tableCellChars);
    expect((blocks[3] as { items: unknown[] }).items).toHaveLength(BLOCK_CAPS.evidence);
    expect(trimmed.map(item => [item.id, item.omitted])).toEqual([['enrichment:points', 3], ['enrichment:table', 3], ['enrichment:evidence', 6]]);
  });
  it('drops only what cannot be cut safely: diagrams over cap, too many columns, non-text cells', () => {
    const { dropped } = validateBlocks([
      { id: 'enrichment:diagram', type: 'mermaid', title: 'D', source: Array.from({ length: BLOCK_CAPS.mermaidLines + 1 }, () => 'a-->b').join('\n') },
      { id: 'enrichment:long', type: 'mermaid', title: 'D', source: 'x'.repeat(BLOCK_CAPS.mermaidChars + 1) },
      { id: 'enrichment:wide', type: 'table', title: 'T', columns: Array.from({ length: BLOCK_CAPS.tableColumns + 1 }, () => 'c'), rows: [['x']] },
      { id: 'enrichment:cell', type: 'table', title: 'T', columns: ['a'], rows: [[{ html: 'x' }]] },
    ], enrichment);
    expect(dropped.map(item => item.reason)).toEqual([
      `source has more than ${BLOCK_CAPS.mermaidLines} lines`,
      `source is ${BLOCK_CAPS.mermaidChars + 1} characters (limit ${BLOCK_CAPS.mermaidChars})`,
      `columns has ${BLOCK_CAPS.tableColumns + 1} items (limit ${BLOCK_CAPS.tableColumns})`,
      'rows[0][0] is not text',
    ]);
  });
  it('pads short table rows like the CLA-260 renderer', () => {
    expect(validateBlocks([{ id: 'enrichment:table', type: 'table', title: 'T', columns: ['a', 'b'], rows: [['1']] }], enrichment).blocks[0]).toMatchObject({ rows: [['1', '']] });
  });
  it('drops deeply nested specs', () => {
    let deep: unknown = 'x';
    for (let level = 0; level < 20; level += 1) deep = { deep };
    expect(validateBlocks([{ id: 'enrichment:summary', type: 'markdown', text: 'ok', extra: deep }], enrichment).dropped[0]?.reason).toBe('block is nested too deeply');
  });
  it('caps the number of blocks and the entries read', () => {
    const many = Array.from({ length: BLOCK_CAPS.maxBlocks + 3 }, (_, index) => ({ id: `enrichment:b${index}`, type: 'markdown', text: 't' }));
    const capped = validateBlocks(many, enrichment);
    expect(capped.blocks).toHaveLength(BLOCK_CAPS.maxBlocks);
    expect(capped.dropped).toHaveLength(3);
    expect(capped.dropped[0]?.reason).toBe(`over the ${BLOCK_CAPS.maxBlocks}-block cap`);
    const flood = validateBlocks(Array.from({ length: BLOCK_CAPS.maxInputEntries + 10 }, () => null), enrichment);
    expect(flood.dropped).toHaveLength(BLOCK_CAPS.maxInputEntries + 1);
    expect(flood.dropped.at(-1)?.reason).toBe('10 entries past the input cap were not read');
  });
});
