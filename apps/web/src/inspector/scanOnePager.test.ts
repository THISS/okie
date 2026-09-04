import { describe, expect, it } from 'vitest';
import {
  assertSafeMermaidSource,
} from '../diagram/MermaidDiagram';
import { inspectorAcceptedSummary, INSPECTOR_EMPTY_SUMMARY } from './inspectorPanel';
import {
  buildScanOnePager,
  ONE_PAGER_MAX_NODES,
  onePagerBand,
  onePagerIncludesEntityPath,
  onePagerLeaksSecretsOrHostPaths,
  structuralSystemSummary,
} from './scanOnePager';
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
    id: 'snapshot:one-pager',
    repositoryId: 'repo:one-pager',
    commitSha: 'abc123def456',
    generatedAt: '2026-01-01T00:00:00Z',
    entities,
    relations,
  };
}

const leakyRefs = [{ path: '/Users/alice/okie/.env', commitSha: 'abc123def456' }];
const leakyEvidence = [{ source: { path: '/home/runner/work/okie/scanRoot', commitSha: 'abc123def456' } }];

describe('scan one-pager copy (CLA-76)', () => {
  it('uses accepted responsibility for the system blurb and container rows', () => {
    const pager = buildScanOnePager({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie', { responsibility: 'Spatial architecture atlas.' }),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie', responsibility: 'React shell.' }),
        entity('container:scan', 'container', '@okie/scan', { parentId: 'system:okie', responsibility: INSPECTOR_EMPTY_SUMMARY }),
      ]),
    });

    expect(pager.systemSummaryKind).toBe('accepted');
    expect(pager.systemSummary).toBe('Spatial architecture atlas.');
    expect(pager.containers.map(item => item.name)).toEqual(['@okie/scan', '@okie/web']);
    expect(pager.containers.find(item => item.id === 'container:web')?.summary).toBe('React shell.');
    expect(pager.containers.find(item => item.id === 'container:scan')?.summary).toBeUndefined();
    expect(inspectorAcceptedSummary({ responsibility: INSPECTOR_EMPTY_SUMMARY })).toBeUndefined();
  });

  it('falls back to honest structure when enrichment did not accept a summary', () => {
    const pager = buildScanOnePager({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie'),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
        entity('container:engine', 'container', 'atlas-engine', { parentId: 'system:okie' }),
      ]),
    });

    expect(pager.systemSummaryKind).toBe('structural');
    expect(pager.systemSummary).toBe(structuralSystemSummary('okie', 2, 3));
    expect(pager.systemSummary).toBe('okie is a software system with 2 containers and 3 entities.');
    expect(pager.systemSummary).not.toMatch(/presents|enables|helps/i);
  });

  it('prefers published childCounts when the neighborhood list is incomplete', () => {
    const pager = buildScanOnePager({
      snapshot: snapshot([
        entity('system:okie', 'softwareSystem', 'okie'),
        entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
      ]),
      childCounts: { 'system:okie': 5 },
    });

    expect(pager.containerCount).toBe(5);
    expect(pager.containers).toHaveLength(1);
    expect(pager.omittedContainerCount).toBe(4);
    expect(pager.systemSummary).toBe('okie is a software system with 5 containers and 2 entities.');
  });
});

describe('scan one-pager Mermaid (CLA-76)', () => {
  it('is deterministic, TB flowchart, and byte-stable across calls', () => {
    const input = snapshot([
      entity('system:okie', 'softwareSystem', 'okie'),
      entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
      entity('container:scan', 'container', '@okie/scan', { parentId: 'system:okie' }),
      entity('person:reader', 'person', 'Reader'),
    ], [
      relation('relation:reader-web', 'person:reader', 'container:web', { label: 'reads' }),
      relation('relation:web-scan', 'container:web', 'container:scan', { kind: 'calls', label: 'calls' }),
    ]);

    const first = buildScanOnePager({ snapshot: input, band: 'container' });
    const second = buildScanOnePager({ snapshot: input, band: 'container' });

    expect(first.mermaidSource).toBe(second.mermaidSource);
    expect(first.mermaidTitle).toBe('L1 → L2 · context → containers');
    assertSafeMermaidSource(first.mermaidSource);
    expect(first.mermaidSource.startsWith('%% okie-one-pager')).toBe(true);
    expect(first.mermaidSource).toContain('flowchart TB');
    expect(first.mermaidSource).toContain(`${mermaidSafeIdentifier('system:okie')} --> ${mermaidSafeIdentifier('container:scan')}`);
    expect(first.mermaidSource).toContain(`${mermaidSafeIdentifier('system:okie')} --> ${mermaidSafeIdentifier('container:web')}`);
    expect(first.mermaidSource).toContain('|"calls"|');
    expect(first.mermaidSource.indexOf('container:scan')).toBeLessThan(first.mermaidSource.indexOf('container:web'));
  });

  it('switches to the current band graph for component and code', () => {
    const input = snapshot([
      entity('system:okie', 'softwareSystem', 'okie'),
      entity('container:web', 'container', '@okie/web', { parentId: 'system:okie' }),
      entity('component:shell', 'component', 'Application shell', { parentId: 'container:web' }),
      entity('code:app', 'code', 'App', { parentId: 'component:shell' }),
    ]);

    const l2 = buildScanOnePager({ snapshot: input, band: 'container' });
    const l3 = buildScanOnePager({ snapshot: input, band: 'component' });
    const l4 = buildScanOnePager({ snapshot: input, band: 'code' });

    expect(onePagerBand('component')).toBe('component');
    expect(l2.mermaidSource).toContain(mermaidSafeIdentifier('system:okie'));
    expect(l2.mermaidSource).not.toContain(mermaidSafeIdentifier('component:shell'));
    expect(l3.mermaidTitle).toContain('containers → components');
    expect(l3.mermaidSource).toContain(mermaidSafeIdentifier('container:web'));
    expect(l3.mermaidSource).toContain(mermaidSafeIdentifier('component:shell'));
    expect(l3.mermaidSource).not.toContain(mermaidSafeIdentifier('system:okie'));
    expect(l4.mermaidSource).toContain(mermaidSafeIdentifier('component:shell'));
    expect(l4.mermaidSource).toContain(mermaidSafeIdentifier('code:app'));
    expect(l4.mermaidSource).not.toContain(mermaidSafeIdentifier('container:web'));
    assertSafeMermaidSource(l3.mermaidSource);
    assertSafeMermaidSource(l4.mermaidSource);
  });

  it('caps the diagram and reports omitted graph nodes honestly', () => {
    const containers = Array.from({ length: ONE_PAGER_MAX_NODES + 4 }, (_, index) => entity(
      `container:${String(index).padStart(2, '0')}`,
      'container',
      `C${index}`,
      { parentId: 'system:okie' },
    ));
    const pager = buildScanOnePager({
      snapshot: snapshot([entity('system:okie', 'softwareSystem', 'okie'), ...containers]),
    });

    expect(pager.graphNodeCount).toBe(ONE_PAGER_MAX_NODES);
    expect(pager.graphOmittedCount).toBe(5);
    expect(pager.containers).toHaveLength(ONE_PAGER_MAX_NODES + 4);
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
    const pager = buildScanOnePager({
      snapshot: snapshot([system, web], [
        relation('relation:web-okie', 'container:web', 'system:okie', { evidence: leakyEvidence, label: 'uses' }),
      ]),
    });

    expect(pager.mermaidSource).not.toContain('graph TD');
    expect(pager.mermaidSource).not.toMatch(/hand-?authored|TODO paste/i);
    expect(onePagerLeaksSecretsOrHostPaths(pager)).toEqual([]);
    expect(onePagerIncludesEntityPath(pager, system)).toBe(false);
    expect(onePagerIncludesEntityPath(pager, web)).toBe(false);
    expect(pager.mermaidSource).not.toContain('/Users/');
    expect(pager.mermaidSource).not.toContain('.env');
    expect(pager.mermaidSource).not.toContain('scanRoot');
    expect(pager.systemSummary).not.toContain('/Users/');
  });

  it('builds a stable L1→L2 diagram from the golden snapshot', () => {
    const first = buildScanOnePager({ snapshot: goldenSnapshot, band: 'container' });
    const second = buildScanOnePager({ snapshot: goldenSnapshot, band: 'container' });
    expect(first.mermaidSource).toBe(second.mermaidSource);
    assertSafeMermaidSource(first.mermaidSource);
    expect(first.systemName).toBeTruthy();
    expect(first.containers.length).toBeGreaterThan(0);
    expect(onePagerLeaksSecretsOrHostPaths(first)).toEqual([]);
  });
});
