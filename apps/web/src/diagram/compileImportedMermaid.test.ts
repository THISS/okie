import { describe, expect, it } from 'vitest';
import { compileImportedMermaidScene } from './compileImportedMermaid';
import { importMermaidToAtlas } from './importMermaid';

const FLOWCHART = `flowchart TD
  Client[Web client] --> Gateway{API gateway}
  Gateway -->|ok| Atlas[Okie atlas]
`;

const SEQUENCE = `sequenceDiagram
  participant User
  participant Atlas
  User->>Atlas: Open map
  Atlas-->>User: Render scene
`;

describe('compileImportedMermaidScene', () => {
  it('compiles a flowchart into atlas nodes, edges, and a camera world — not an SVG', () => {
    const imported = importMermaidToAtlas(FLOWCHART);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const scene = compileImportedMermaidScene(imported.atlas);
    expect(scene.protocolSnapshot).toBeDefined();
    expect(JSON.stringify(scene)).not.toMatch(/<svg/i);
    expect(scene.entities.some(entity => entity.name === 'Web client')).toBe(true);
    expect(scene.entities.some(entity => entity.name === 'API gateway')).toBe(true);
    expect(scene.relations.some(relation => relation.label === 'ok')).toBe(true);
    expect(scene.projection?.projectedRelationsByDetail.container.length).toBeGreaterThan(0);
    expect(scene.entities.every(entity => Number.isFinite(entity.x + entity.y + entity.width + entity.height))).toBe(true);
    expect(scene.frozenRevision).toBe('imported-mermaid');
  });

  it('compiles a sequence into atlas participants and call edges', () => {
    const imported = importMermaidToAtlas(SEQUENCE);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const scene = compileImportedMermaidScene(imported.atlas);
    expect(JSON.stringify(scene)).not.toMatch(/<svg/i);
    expect(scene.entities.some(entity => entity.name === 'User')).toBe(true);
    expect(scene.entities.some(entity => entity.name === 'Atlas')).toBe(true);
    expect(scene.relations.map(relation => relation.label).sort()).toEqual(['Open map', 'Render scene']);
    const containerIds = new Set(scene.projection?.entityIdsByDetail.container ?? []);
    expect(scene.entities.filter(entity => containerIds.has(entity.id)).length).toBeGreaterThan(1);
  });
});
