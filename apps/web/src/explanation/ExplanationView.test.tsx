import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OperatorExplanation } from '../operator/api';
import { ExplanationTable, ExplanationView } from './ExplanationView';
import { evidenceLabel, evidenceSourceUrl, explanationViewModel, hasExplanationContent, kindLabel, legacyDiagramSource } from './explanationModel';

const names = new Map([['component:packages-architecture-src-index-ts', 'Architecture barrel'], ['component:db', 'Database']]);
const entityName = (id: string) => names.get(id);

const v3: OperatorExplanation = {
  format: 'v3',
  summary: 'Owns the **semantic model**.\n\nEverything else imports it.',
  keyPoints: ['Start in `model.ts`.', 'Normalization is *deterministic*.'],
  diagram: 'flowchart LR\n  a["Model"] --> b["Compiler"]',
  table: { caption: 'Key files', columns: ['File', 'Role'], rows: [['`model.ts`', 'Types'], ['`validation.ts`', 'Checks']] },
  evidence: [
    { entityId: 'component:packages-architecture-src-index-ts', path: 'packages/architecture/src/index.ts', startLine: 3, endLine: 12 },
    { entityId: 'component:db' },
  ],
};

const legacy: OperatorExplanation = {
  summary: 'Accepts public requests.',
  roleWithinParent: 'Gateway for the app',
  interactions: ['Calls component:db for reads'],
  evidence: [{ entityId: 'component:packages-architecture-src-index-ts' }, { path: 'src/api.ts', startLine: 9 }],
  diagram: { nodes: ['component:packages-architecture-src-index-ts', 'component:unknown-raw-id'], edges: [{ from: 'component:packages-architecture-src-index-ts', to: 'component:unknown-raw-id', label: 'reads | click evil' }] },
};

describe('v3 explanation rendering', () => {
  const markup = renderToStaticMarkup(<ExplanationView entityName={entityName} explanation={v3} onOpenEvidence={() => undefined} subjectName="Architecture"/>);
  it('renders summary → key points → diagram → table → evidence in order', () => {
    const order = ['explanation-summary', 'explanation-key-points', 'semantic-mermaid-diagram', 'explanation-table', 'explanation-evidence'].map(name => markup.indexOf(name));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain('<strong>semantic model</strong>');
    expect(markup).toContain('<li>Start in <code>model.ts</code>.</li>');
  });
  it('renders the table inline with an expand dialog', () => {
    expect(markup).toContain('<th scope="col">File</th>');
    expect(markup).toContain('<td><code>validation.ts</code></td>');
    expect(markup).toContain('Expand table');
    expect(markup).toMatch(/<dialog[^>]*aria-modal="true"/u);
    expect(markup).toContain('aria-label="Close expanded table"');
  });
  it('labels evidence by path:lines or human name, never raw ids, as source buttons', () => {
    expect(markup).toContain('<code>packages/architecture/src/index.ts:3–12</code>');
    expect(markup).toContain('<code>Database</code>');
    expect(markup).not.toContain('component:');
    expect(markup).toMatch(/<button class="explanation-evidence-link"[^>]*title="Open source: packages\/architecture\/src\/index.ts:3–12"/u);
  });
  it('uses an external immutable link when the host supplies one', () => {
    const linked = renderToStaticMarkup(<ExplanationView entityName={entityName} evidenceHref={evidence => evidenceSourceUrl(evidence, { owner: 'acme', repo: 'app', commitSha: 'a'.repeat(40) })} explanation={v3} subjectName="Architecture"/>);
    expect(linked).toContain(`href="https://github.com/acme/app/blob/${'a'.repeat(40)}/packages/architecture/src/index.ts#L3-L12"`);
    expect(linked).toContain('rel="noopener noreferrer"');
    // No path → no link, rendered as static text.
    expect(linked).toContain('is-static');
  });
  it('omits the diagram and table when absent and renders sanitised provider markup literally', () => {
    const plain = renderToStaticMarkup(<ExplanationView entityName={entityName} explanation={{ format: 'v3', summary: '<script>x</script>', keyPoints: ['[a](javascript:1)'], evidence: [] }} subjectName="X"/>);
    expect(plain).not.toContain('semantic-mermaid-diagram');
    expect(plain).not.toContain('explanation-table');
    expect(plain).not.toContain('<script>');
    expect(plain).toContain('[a](javascript:1)');
  });
});

describe('legacy explanation rendering', () => {
  it('renders summary, evidence and a named diagram without raw ids; hides interactions in the atlas', () => {
    const markup = renderToStaticMarkup(<ExplanationView entityName={entityName} explanation={legacy} subjectName="API"/>);
    expect(markup).toContain('data-explanation-format="legacy"');
    expect(markup).toContain('Accepts public requests.');
    expect(markup).toContain('<code>Architecture barrel</code>');
    expect(markup).toContain('<code>src/api.ts:9</code>');
    expect(markup).not.toContain('component:');
    expect(markup).not.toContain('Gateway for the app');
    expect(markup).not.toContain('Calls component');
    expect(markup).toContain('semantic-mermaid-diagram');
  });
  it('gives the diagram explanation-appropriate fallback copy', () => {
    expect(renderToStaticMarkup(<ExplanationView entityName={entityName} explanation={v3} subjectName="X"/>)).not.toContain('architecture brief');
  });
  it('keeps legacy notes collapsed for operator audit', () => {
    const markup = renderToStaticMarkup(<ExplanationView audit diagramError="too many nodes" entityName={entityName} explanation={legacy} subjectName="API"/>);
    expect(markup).toMatch(/<details class="explanation-legacy-notes"><summary>/u);
    expect(markup).toContain('Gateway for the app');
    expect(markup).toContain('Optional diagram/table omitted: too many nodes');
    const v3Audit = renderToStaticMarkup(<ExplanationView audit entityName={entityName} explanation={{ ...v3, table: undefined, diagramError: 'rejected table: row width; rejected diagram: click directive' }} subjectName="X"/>);
    expect(v3Audit.match(/<p class="explanation-note">[^<]*<\/p>/gu)).toEqual(['<p class="explanation-note">Optional diagram/table omitted: rejected table: row width; rejected diagram: click directive</p>']);
    // The atlas (no audit) never shows the operator-facing rejection reason.
    expect(renderToStaticMarkup(<ExplanationView entityName={entityName} explanation={{ ...v3, diagramError: 'rejected table: x' }} subjectName="X"/>)).not.toContain('explanation-note');
  });
  it('builds diagram source from human names and strips Mermaid syntax from labels', () => {
    const model = explanationViewModel(legacy);
    const source = model?.format === 'legacy' ? legacyDiagramSource(model.diagram, entityName) : undefined;
    expect(source).toContain('n0["Architecture barrel"]');
    expect(source).toContain('n1["Entity 2"]');
    expect(source).toContain('|reads click evil|');
    expect(source).not.toContain('component:');
  });
  it('never crashes on malformed or partial content', () => {
    for (const value of [null, 'text', 42, {}, { summary: 7, evidence: 'x' }, { format: 'v3', keyPoints: 'nope', table: { columns: ['a'], rows: 'x' }, evidence: [null, { startLine: 2 }] }, { diagram: { nodes: 'x' }, interactions: [1, 2] }]) {
      expect(() => renderToStaticMarkup(<ExplanationView entityName={entityName} explanation={value} subjectName="X"/>)).not.toThrow();
    }
    expect(explanationViewModel({ format: 'v3', summary: 's', keyPoints: [], evidence: [], table: { columns: ['a', 'b'], rows: [['only one']] } })).toMatchObject({ table: { rows: [['only one', '']] } });
  });
});

describe('explanation table dialog (static; open/Esc/focus-return/backdrop need a DOM — covered by browser QA)', () => {
  const table = { caption: 'Key files', columns: ['File', 'Role'], rows: [['`a.ts`', '**Entry**']] };
  const markup = renderToStaticMarkup(<ExplanationTable table={table} title="Fallback title"/>);
  it('renders a closed modal dialog with an accessible name and a close control', () => {
    const dialog = /<dialog([^>]*)>/u.exec(markup)?.[1] ?? '';
    expect(dialog).toContain('aria-label="Key files"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).not.toMatch(/\sopen\b/u);
    expect(markup).toContain('aria-label="Expand table: Key files"');
    expect(markup).toContain('aria-label="Close expanded table"');
  });
  it('keeps one inline copy of the grid until expanded and uses the title when there is no caption', () => {
    expect(markup.match(/<table>/gu)).toHaveLength(1);
    expect(markup).toContain('<td><strong>Entry</strong></td>');
    expect(markup.indexOf('<table>')).toBeLessThan(markup.indexOf('<dialog'));
    expect(renderToStaticMarkup(<ExplanationTable table={{ columns: ['a', 'b'], rows: [['1', '2']] }} title="Fallback title"/>)).toContain('aria-label="Expand table: Fallback title"');
  });
});

describe('explanation helpers', () => {
  it('leads only with explanations that have content', () => {
    expect(hasExplanationContent(explanationViewModel({ format: 'v3', summary: '  ', keyPoints: [], evidence: [] }))).toBe(false);
    expect(hasExplanationContent(explanationViewModel({ summary: '', evidence: [{ path: 'a.ts' }] }))).toBe(true);
    expect(hasExplanationContent(explanationViewModel({ format: 'v3', summary: '', keyPoints: ['x'], evidence: [] }))).toBe(true);
    expect(hasExplanationContent(explanationViewModel(null))).toBe(false);
  });
  it('formats evidence labels', () => {
    expect(evidenceLabel({ path: 'a.ts', startLine: 4, endLine: 4 }, entityName)).toBe('a.ts:4');
    expect(evidenceLabel({ entityId: 'component:nope' }, entityName)).toBe('Captured architecture evidence');
  });
  it('refuses unsafe source links', () => {
    expect(evidenceSourceUrl({ path: '../etc/passwd' }, { owner: 'a', repo: 'b', commitSha: 'a'.repeat(40) })).toBeUndefined();
    expect(evidenceSourceUrl({ path: 'a.ts' }, { owner: 'a', repo: 'b', commitSha: 'main' })).toBeUndefined();
    expect(evidenceSourceUrl({ path: 'a.ts' }, { owner: 'a', repo: 'b' })).toBeUndefined();
  });
  it('humanises C4 kinds', () => {
    expect(kindLabel('softwareSystem')).toBe('Software system');
    expect(kindLabel('someNewKind')).toBe('Some new kind');
  });
});
