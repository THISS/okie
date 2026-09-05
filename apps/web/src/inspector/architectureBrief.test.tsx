import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { assertSafeMermaidSource } from '../diagram/MermaidDiagram';
import { inspectorAcceptedSummary, INSPECTOR_EMPTY_SUMMARY } from './inspectorPanel';
import { ArchitectureBriefView } from './ArchitectureBrief';
import {
  architectureBriefIncludesEntityPath,
  architectureBriefLeaksSecretsOrHostPaths,
  architectureKindLabel,
  BRIEF_MAX_FLOWS,
  BRIEF_MAX_NODES,
  buildArchitectureBrief,
  STRUCTURAL_INVENTED_PROSE,
} from './architectureBrief';
import { structuralSystemSummary } from './scanOnePager';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from '../renderer/scanFixture';
import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, EntityKind } from '@okie/architecture';
import { goldenSnapshot, mermaidSafeIdentifier } from '@okie/scene-compiler';

function entity(
  id: string,
  kind: EntityKind,
  name: string,
  extra: Partial<ArchitectureEntity> = {},
): ArchitectureEntity {
  return {
    id,
    kind,
    name,
    sourceRefs: extra.sourceRefs ?? [],
    ...extra,
  };
}

function relation(
  id: string,
  from: string,
  to: string,
  extra: Partial<ArchitectureRelation> = {},
): ArchitectureRelation {
  return {
    id,
    from,
    to,
    kind: extra.kind ?? 'uses',
    evidence: extra.evidence ?? [{ source: { path: 'src/safe.ts', commitSha: 'abc123def456' } }],
    ...extra,
  };
}

function snapshot(entities: ArchitectureEntity[], relations: ArchitectureRelation[] = []): ArchitectureSnapshot {
  return {
    schemaVersion: 1,
    id: 'snapshot:architecture-brief',
    repositoryId: 'repo:architecture-brief',
    commitSha: 'abc123def456',
    generatedAt: '2026-01-01T00:00:00Z',
    entities,
    relations,
  };
}

const leakyRefs = [{ path: '/Users/alice/okie/.env', commitSha: 'abc123def456' }];
const leakyEvidence = [{ source: { path: '/home/runner/work/okie/scanRoot', commitSha: 'abc123def456' } }];

describe('architecture brief copy (CLA-87)', () => {
  it('uses accepted responsibility for the system blurb and container sections', () => {
    const brief = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie', { responsibility: 'Spatial architecture atlas.' }),
        entity('container:web', 'container', '@okie/web', {
          parentId: 'system:okie',
          responsibility: 'React shell.',
          technology: ['React', 'TypeScript'],
        }),
        entity('container:scan', 'container', '@okie/scan', { parentId: 'system:okie', responsibility: INSPECTOR_EMPTY_SUMMARY }),
      ]),
    });

    expect(brief.systemSummaryKind).toBe('accepted');
    expect(brief.systemSummary).toBe('Spatial architecture atlas.');
    expect(brief.markdown).toContain('# okie');
    expect(brief.markdown).toContain('Spatial architecture atlas.');
    expect(brief.markdown).toContain('### @okie/web');
    expect(brief.markdown).toContain('React shell.');
    expect(brief.markdown).toContain('Technology: React · TypeScript.');
    expect(brief.markdown).toContain('@okie/scan is a container.');
    expect(brief.containers.find(item => item.id === 'container:scan')?.summary).toBeUndefined();
    expect(inspectorAcceptedSummary({ responsibility: INSPECTOR_EMPTY_SUMMARY })).toBeUndefined();
  });

  it('falls back to honest structure when enrichment did not accept a summary', () => {
    const brief = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie'),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
        entity('container:engine', 'container', 'atlas-engine', { parentId: 'system:okie' }),
        entity('external:react', 'externalSystem', 'react'),
        entity('external:dompurify', 'externalSystem', 'dompurify'),
      ]),
    });

    expect(brief.systemSummaryKind).toBe('structural');
    expect(brief.systemSummary).toBe(structuralSystemSummary('okie', 2, 5));
    expect(brief.systemSummary).toBe('okie is a software system with 2 containers and 5 entities.');
    expect(brief.markdown).not.toMatch(STRUCTURAL_INVENTED_PROSE);
    expect(brief.worldSentence).toBe('okie meets the world through 2 external systems.');
    expect(brief.worldSentence).not.toMatch(/react|dompurify/i);
    expect(brief.containers.find(item => item.id === 'container:web')?.summary).toBeUndefined();
    expect(brief.markdown).toContain('@okie/web is a container.');
  });

  it('names people and accepted externals without listing unenriched npm packages', () => {
    const brief = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie', { responsibility: 'Evidence-backed atlas.' }),
        entity('person:dev', 'person', 'Developer / maintainer'),
        entity('external:source', 'externalSystem', 'Source repository', { responsibility: 'Supplies worktree source references.' }),
        entity('external:react', 'externalSystem', 'react'),
        entity('external:dompurify', 'externalSystem', 'dompurify'),
      ]),
    });

    expect(brief.worldSentence).toBe(
      'okie meets the world through Developer / maintainer, Source repository, and 2 external systems.',
    );
    expect(brief.markdown).toContain(brief.worldSentence!);
    expect(brief.markdown).not.toMatch(/^okie meets the world through react/m);
  });

  it('prefers published childCounts when the neighborhood list is incomplete', () => {
    const brief = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie'),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
      ]),
      childCounts: { 'system:okie': 5 },
    });

    expect(brief.containerCount).toBe(5);
    expect(brief.containers).toHaveLength(1);
    expect(brief.omittedContainerCount).toBe(4);
    expect(brief.containerIntro).toBe('okie includes 5 containers.');
    expect(brief.markdown).toContain('1 of 5 containers are loaded in this neighborhood.');
  });
});

describe('architecture brief Mermaid (CLA-87)', () => {
  it('embeds deterministic context and flow diagrams in the markdown', () => {
    const input = snapshot([
      entity('system:okie', 'softwareSystem', 'okie'),
      entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
      entity('container:scan', 'container', '@okie/scan', { parentId: 'system:okie' }),
      entity('person:reader', 'person', 'Reader'),
    ], [
      relation('relation:reader-web', 'person:reader', 'container:web', { label: 'reads' }),
      relation('relation:web-scan', 'container:web', 'container:scan', { kind: 'calls', label: 'calls' }),
    ]);

    const first = buildArchitectureBrief({ snapshot: input });
    const second = buildArchitectureBrief({ snapshot: input });

    expect(first.markdown).toBe(second.markdown);
    expect(first.contextMermaid).toBe(second.contextMermaid);
    expect(first.flowsMermaid).toBe(second.flowsMermaid);
    expect(first.markdown).toContain('```mermaid');
    expect(first.markdown.match(/```mermaid/g)?.length).toBe(2);
    expect(first.contextMermaid.startsWith('%% okie-architecture-brief')).toBe(true);
    expect(first.contextMermaid).toContain('flowchart TB');
    expect(first.flowsMermaid).toContain('flowchart LR');
    assertSafeMermaidSource(first.contextMermaid);
    assertSafeMermaidSource(first.flowsMermaid!);
    expect(first.contextMermaid).toContain(`${mermaidSafeIdentifier('system:okie')} --> ${mermaidSafeIdentifier('container:scan')}`);
    expect(first.flows.map(item => item.label)).toEqual(['reads', 'calls']);
    expect(first.markdown).toContain('- Reader reads @okie/web');
    expect(first.markdown).toContain('- @okie/web calls @okie/scan');
  });

  it('caps diagrams and reports omitted graph nodes honestly', () => {
    const containers = Array.from({ length: BRIEF_MAX_NODES + 4 }, (_, index) => entity(
      `container:${String(index).padStart(2, '0')}`,
      'container',
      `C${index}`,
      { parentId: 'system:okie' },
    ));
    const brief = buildArchitectureBrief({
      snapshot: snapshot([entity('system:okie', 'softwareSystem', 'okie'), ...containers]),
    });

    expect(brief.graphNodeCount).toBe(BRIEF_MAX_NODES);
    expect(brief.graphOmittedCount).toBe(5);
    expect(brief.containers).toHaveLength(BRIEF_MAX_NODES + 4);
    expect(brief.markdown).toContain(`Diagram shows ${BRIEF_MAX_NODES} of ${BRIEF_MAX_NODES + 5} nodes.`);
  });

  it('caps key flows and stays silent when the neighborhood has none', () => {
    const empty = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie'),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
      ]),
    });
    expect(empty.flows).toEqual([]);
    expect(empty.flowsMermaid).toBeUndefined();
    expect(empty.markdown).toContain('No key flows are in this snapshot neighborhood.');

    const many = Array.from({ length: BRIEF_MAX_FLOWS + 3 }, (_, index) => relation(
      `relation:flow-${String(index).padStart(2, '0')}`,
      'container:web',
      'container:scan',
      { label: `flow-${index}` },
    ));
    const capped = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie'),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
        entity('container:scan', 'container', '@okie/scan', { parentId: 'system:okie' }),
      ], many),
    });
    expect(capped.flows).toHaveLength(BRIEF_MAX_FLOWS);
    expect(capped.omittedFlowCount).toBe(3);
    expect(capped.markdown).toContain(`List shows ${BRIEF_MAX_FLOWS} of ${BRIEF_MAX_FLOWS + 3} flows.`);
  });

  it('does not paste a hand-authored diagram and never emits host paths or secrets', () => {
    const system = entity('system:okie', 'softwareSystem', 'okie', {
      sourceRefs: leakyRefs,
      responsibility: 'Hosts the atlas renderer.',
    });
    const web = entity('container:web', 'container', '@okie/web', {
      parentId: 'system:okie',
      sourceRefs: leakyRefs,
      responsibility: 'React shell.',
    });
    const brief = buildArchitectureBrief({
      snapshot: snapshot([system, web], [
        relation('relation:web-okie', 'container:web', 'system:okie', { evidence: leakyEvidence, label: 'uses' }),
      ]),
    });

    expect(brief.markdown).not.toContain('graph TD');
    expect(brief.markdown).not.toMatch(/hand-?authored|TODO paste/i);
    expect(architectureBriefLeaksSecretsOrHostPaths(brief)).toEqual([]);
    expect(architectureBriefIncludesEntityPath(brief, system)).toBe(false);
    expect(architectureBriefIncludesEntityPath(brief, web)).toBe(false);
    expect(brief.markdown).not.toContain('/Users/');
    expect(brief.markdown).not.toContain('.env');
    expect(brief.markdown).not.toContain('scanRoot');
    expect(brief.systemSummary).not.toContain('/Users/');
  });

  it('builds a stable L1→L2 document from the golden snapshot', () => {
    const first = buildArchitectureBrief({ snapshot: goldenSnapshot });
    const second = buildArchitectureBrief({ snapshot: goldenSnapshot });
    expect(first.markdown).toBe(second.markdown);
    assertSafeMermaidSource(first.contextMermaid);
    if (first.flowsMermaid) assertSafeMermaidSource(first.flowsMermaid);
    expect(first.systemName).toBeTruthy();
    expect(first.containers.length).toBeGreaterThan(0);
    expect(first.markdown).toContain('```mermaid');
    expect(first.markdown).toContain('## System');
    expect(first.markdown).toContain('## Containers');
    expect(first.markdown).toContain('## Key flows');
    expect(architectureBriefLeaksSecretsOrHostPaths(first)).toEqual([]);
    expect(architectureKindLabel('dataStore')).toBe('data store');
  });
});

describe('architecture brief view (CLA-87)', () => {
  it('renders markdown sections with inline Mermaid instead of a container button list', () => {
    const brief = buildArchitectureBrief({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie', { responsibility: 'Spatial architecture atlas.' }),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie', responsibility: 'React shell.' }),
      ], [
        relation('relation:okie-web', 'system:okie', 'container:web', { label: 'contains runtime' }),
      ]),
    });
    const markup = renderToStaticMarkup(
      <ArchitectureBriefView
        brief={brief}
        containerAvailable={() => true}
        honestyChip="Enrichment skipped (no key)"
        onOpenContainer={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="architecture-brief"');
    expect(markup).toContain('data-testid="architecture-brief-context-mermaid"');
    expect(markup).toContain('data-testid="architecture-brief-flows-mermaid"');
    expect(markup).toContain('Copy markdown');
    expect(markup).toContain('Architecture brief');
    expect(markup).toContain('Spatial architecture atlas.');
    expect(markup).toContain('<h2>System</h2>');
    expect(markup).toContain('<h2>Containers</h2>');
    expect(markup).toContain('<h2>Key flows</h2>');
    expect(markup).not.toContain('data-testid="one-pager-containers"');
    expect(markup).not.toContain('L1–L2 · One-pager');
    expect(markup).not.toContain('scanRoot');
  });

  it('shows enrichment honesty on structural copy and hides it when summaries are accepted', () => {
    const structural = buildArchitectureBrief({
      snapshot: snapshot([entity('system:okie', 'softwareSystem', 'okie')]),
    });
    const accepted = buildArchitectureBrief({
      snapshot: snapshot([entity('system:okie', 'softwareSystem', 'okie', { responsibility: 'Atlas.' })]),
    });
    const skipped = renderToStaticMarkup(
      <ArchitectureBriefView
        brief={structural}
        containerAvailable={() => false}
        honestyChip="Enrichment skipped (no key)"
        onOpenContainer={() => {}}
      />,
    );
    const enriched = renderToStaticMarkup(
      <ArchitectureBriefView
        brief={accepted}
        containerAvailable={() => false}
        honestyChip="Enrichment skipped (no key)"
        onOpenContainer={() => {}}
      />,
    );
    expect(structural.systemSummaryKind).toBe('structural');
    expect(skipped).toContain('data-testid="architecture-brief-honesty"');
    expect(skipped).toContain('Enrichment skipped (no key)');
    expect(enriched).not.toContain('data-testid="architecture-brief-honesty"');
  });
});

describe('CLA-87 does not rewrite hang-guard or healthz', () => {
  it('leaves the 2000 hang-guard and CLA-66 lazy compile in place', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    const fixture = readFileSync(new URL('../renderer/scanFixture.ts', import.meta.url), 'utf8');
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });

  it('does not put keys or host paths on healthz', () => {
    const healthz = readFileSync(new URL('../../../server/src/localDefaults.ts', import.meta.url), 'utf8');
    const returned = healthz.slice(healthz.indexOf('return {'), healthz.indexOf('};', healthz.indexOf('return {')) + 2);
    expect(returned).toContain('service:');
    expect(returned).toContain('ok: true');
    expect(returned).toContain('public: false');
    expect(returned).toContain('bind:');
    expect(returned).toContain('enrich:');
    expect(returned).not.toMatch(/scanRoot|OPENROUTER|apiKey|api_key/);
  });
});
