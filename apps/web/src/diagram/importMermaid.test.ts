import { describe, expect, it } from 'vitest';
import { validateSnapshot } from '@okie/architecture';
import { extractMermaidSources, importMermaidToAtlas } from './importMermaid';

const FLOWCHART = `flowchart TD
  Client[Web client] --> Gateway{API gateway}
  Gateway -->|ok| Atlas[Okie atlas]
  Gateway -->|fail| Error[Error page]
`;

const SEQUENCE = `sequenceDiagram
  participant User
  participant Atlas
  User->>Atlas: Open map
  Atlas-->>User: Render scene
`;

const C4 = `C4Context
title System context
Person(user, "Reader", "Explores architecture")
System(okie, "Okie", "Spatial atlas")
System_Ext(github, "GitHub", "Source hosting")
Rel(user, okie, "explores")
Rel(okie, github, "reads evidence")
`;

describe('extractMermaidSources', () => {
  it('returns raw mermaid when there is no fence', () => {
    expect(extractMermaidSources(FLOWCHART)).toEqual([FLOWCHART.trim()]);
  });

  it('extracts one or more mermaid fences from markdown', () => {
    const markdown = `Notes\n\n\`\`\`mermaid\n${FLOWCHART}\n\`\`\`\n\nMore\n\n\`\`\`mermaid\n${SEQUENCE}\n\`\`\`\n`;
    expect(extractMermaidSources(markdown)).toEqual([FLOWCHART.trim(), SEQUENCE.trim()]);
  });
});

describe('importMermaidToAtlas', () => {
  it('projects a flowchart onto a snapshot with Okie containers and uses edges', () => {
    const result = importMermaidToAtlas(FLOWCHART);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateSnapshot(result.atlas.snapshot)).toEqual([]);
    expect(result.atlas.diagramTypes).toEqual(['flowchart']);
    expect(result.atlas.frameDetail).toBe('container');
    const names = result.atlas.snapshot.entities.map(entity => entity.name);
    expect(names).toEqual(expect.arrayContaining(['Web client', 'API gateway', 'Okie atlas', 'Error page']));
    expect(result.atlas.snapshot.entities.some(entity => entity.kind === 'container')).toBe(true);
    expect(result.atlas.snapshot.relations.some(relation => relation.kind === 'uses' && relation.label === 'ok')).toBe(true);
    expect(result.atlas.snapshot.relations.some(relation => relation.kind === 'uses' && relation.label === 'fail')).toBe(true);
    expect(result.atlas.snapshot.repositoryId).toBe('repo:imported-mermaid');
  });

  it('projects a sequence diagram onto participants and calls', () => {
    const result = importMermaidToAtlas(SEQUENCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateSnapshot(result.atlas.snapshot)).toEqual([]);
    expect(result.atlas.diagramTypes).toEqual(['sequence']);
    const names = result.atlas.snapshot.entities.map(entity => entity.name);
    expect(names).toEqual(expect.arrayContaining(['User', 'Atlas']));
    expect(result.atlas.snapshot.relations.map(relation => relation.label).sort()).toEqual(['Open map', 'Render scene']);
    expect(result.atlas.snapshot.relations.every(relation => relation.kind === 'calls')).toBe(true);
  });

  it('projects a C4 context diagram onto people, systems, and uses relations', () => {
    const result = importMermaidToAtlas(C4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateSnapshot(result.atlas.snapshot)).toEqual([]);
    expect(result.atlas.diagramTypes).toEqual(['c4']);
    const byName = Object.fromEntries(result.atlas.snapshot.entities.map(entity => [entity.name, entity]));
    expect(byName.Reader?.kind).toBe('person');
    expect(byName.Okie?.kind).toBe('softwareSystem');
    expect(byName.GitHub?.kind).toBe('externalSystem');
    expect(result.atlas.snapshot.relations.some(relation => relation.label === 'explores')).toBe(true);
  });

  it('imports two fenced diagrams onto one snapshot', () => {
    const markdown = `\`\`\`mermaid\n${FLOWCHART}\n\`\`\`\n\n\`\`\`mermaid\n${SEQUENCE}\n\`\`\`\n`;
    const result = importMermaidToAtlas(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.atlas.diagramTypes).toEqual(['flowchart', 'sequence']);
    expect(result.atlas.snapshot.entities.some(entity => entity.name === 'Web client')).toBe(true);
    expect(result.atlas.snapshot.entities.some(entity => entity.name === 'User')).toBe(true);
  });

  it('keeps subgraph children nested under the subgraph container', () => {
    const result = importMermaidToAtlas(`flowchart LR
  subgraph Web [Web app]
    UI[Shell]
  end
  UI --> API[Scan server]
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.atlas.snapshot.entities.map(entity => [entity.name, entity]));
    expect(byName['Web app']?.kind).toBe('container');
    expect(byName.Shell?.kind).toBe('component');
    expect(byName.Shell?.parentId).toBe(byName['Web app']?.id);
    expect(byName['Scan server']?.kind).toBe('container');
  });

  it('is deterministic for the same source', () => {
    const first = importMermaidToAtlas(FLOWCHART);
    const second = importMermaidToAtlas(FLOWCHART);
    expect(first).toEqual(second);
  });

  it('fails softly on empty, invalid, and unsupported diagrams', () => {
    expect(importMermaidToAtlas('').ok).toBe(false);
    expect(importMermaidToAtlas('   ').ok).toBe(false);
    const empty = importMermaidToAtlas('');
    if (!empty.ok) expect(empty.message).toMatch(/atlas is unchanged/i);

    const garbage = importMermaidToAtlas('this is not mermaid');
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.message).toMatch(/atlas is unchanged/i);

    const pie = importMermaidToAtlas('pie title Pets\n  "Dogs" : 386\n  "Cats" : 85');
    expect(pie.ok).toBe(false);
    if (!pie.ok) expect(pie.message).toMatch(/cannot be imported/i);

    const broken = importMermaidToAtlas('flowchart TD\n  A[Start -->');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.message).toMatch(/atlas is unchanged/i);
  });

  it('does not fetch remote content or execute click handlers', () => {
    const source = `flowchart TD
  A[Start] --> B[Finish]
  click B href "https://example.invalid/readme" _blank
`;
    const result = importMermaidToAtlas(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.atlas.snapshot)).not.toContain('example.invalid');
  });
});
