import { describe, expect, it } from 'vitest';
import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, ArchitectureView, EntityKind } from '@okie/architecture';
import { goldenSnapshot, goldenView } from '@okie/scene-compiler';
import { pngDimensions, pngSignatureOk } from './atlasCard';
import {
  atlasStructureCardLayout,
  fitStructureLabel,
  renderAtlasStructureCardPng,
  STRUCTURE_CARD_MAX_BOXES,
  STRUCTURE_CARD_REFERENCE_INPUT,
  STRUCTURE_CARD_REFERENCE_SHA256,
  STRUCTURE_CARD_RENDERER_VERSION,
  structureCardPixelsSha256,
  structureCardSelfCheck,
  type StructureCardLayout,
} from './atlasStructureCard';

/**
 * CLA-319: stored cards are keyed `card-<STRUCTURE_CARD_RENDERER_VERSION>.png` and never overwritten, so a layout change
 * without a version bump would leave some versions carded by the old renderer and new ones by the new one under the same
 * key. This pin ties the pixels to the version: when it drifts, bump STRUCTURE_CARD_RENDERER_VERSION
 * (apps/web/src/atlasStructureCardVersion.ts: r1 → r2), re-pin STRUCTURE_CARD_REFERENCE_SHA256 there, and run
 * `pnpm publish:atlas --backfill-cards` before deploying the Worker (see docs/deploy/cloudflare-runbook.md).
 */
const REFERENCE_VERSION = 'r1';
const golden = STRUCTURE_CARD_REFERENCE_INPUT;

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function entity(id: string, name: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return { id, name, kind, sourceRefs: [{ path: `src/${id.replace(/\W/g, '-')}.ts`, commitSha: COMMIT }], ...(parentId ? { parentId } : {}) };
}

/** A small synthetic atlas: one system, `containers` containers (each with `files` components), an external peer. */
function syntheticAtlas(input: { containers: string[]; files?: number; relations?: Array<[number, number]> }): { snapshot: ArchitectureSnapshot; view: ArchitectureView } {
  const entities: ArchitectureEntity[] = [entity('system:root', 'Demo system', 'softwareSystem'), entity('external:db', 'Postgres', 'externalSystem')];
  input.containers.forEach((name, i) => {
    entities.push(entity(`container:c${i}`, name, 'container', 'system:root'));
    for (let f = 0; f < (input.files ?? 1); f += 1) entities.push(entity(`component:c${i}-f${f}`, `src/c${i}/file${f}.ts`, 'component', `container:c${i}`));
  });
  const relations: ArchitectureRelation[] = (input.relations ?? []).map(([from, to], i) => ({
    id: `rel:${i}`,
    from: `container:c${from}`,
    to: `container:c${to}`,
    kind: 'uses',
    evidence: [{ source: { path: `src/rel-${i}.ts`, commitSha: COMMIT } }],
  }));
  relations.push({ id: 'rel:db', from: 'container:c0', to: 'external:db', kind: 'dependsOn', evidence: [{ source: { path: 'src/db.ts', commitSha: COMMIT } }] });
  const snapshot: ArchitectureSnapshot = { schemaVersion: 1, id: 'snapshot:synthetic', repositoryId: 'repo:synthetic', commitSha: COMMIT, generatedAt: '2026-01-01T00:00:00.000Z', entities, relations };
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: 'view:synthetic',
    snapshotId: snapshot.id,
    name: 'synthetic',
    rootEntityId: 'system:root',
    entityIds: entities.map(value => value.id),
    relationIds: relations.map(value => value.id),
    layout: { nodes: Object.fromEntries(entities.map((value, i) => [value.id, { x: i, y: 0, width: 4, height: 4 }])) },
  };
  return { snapshot, view };
}

/** The drawn text must come from the entity's own name (whole, a line break of it, or a cut of it with `...`). */
function labelFromName(label: string, name: string): boolean {
  const parts = label.split('...').map(part => part.trim()).filter(Boolean);
  const squashed = name.replace(/\s+/g, '');
  return parts.length > 0 && parts.every(part => squashed.includes(part.replace(/\s+/g, '')));
}

function drawnNames(layout: StructureCardLayout): string[] {
  return layout.boxes.map(box => box.name);
}

describe('structure share card (CLA-319)', () => {
  it('pins the reference card pixels to STRUCTURE_CARD_RENDERER_VERSION (the same constant the publish self-check uses)', () => {
    const actual = structureCardPixelsSha256(renderAtlasStructureCardPng(golden));
    expect(
      actual,
      `The structure card pixels changed (the reference now renders sha256 '${actual}'). Bump STRUCTURE_CARD_RENDERER_VERSION `
        + 'in apps/web/src/atlasStructureCardVersion.ts and re-pin STRUCTURE_CARD_REFERENCE_SHA256 there (and REFERENCE_VERSION '
        + 'here); then run `pnpm publish:atlas --backfill-cards` so published versions get the new card.',
    ).toBe(STRUCTURE_CARD_REFERENCE_SHA256);
    expect(REFERENCE_VERSION, 'When you bump STRUCTURE_CARD_RENDERER_VERSION, re-pin the reference sha256 and REFERENCE_VERSION together.').toBe(STRUCTURE_CARD_RENDERER_VERSION);
    expect(structureCardSelfCheck()).toEqual({ ok: true, sha256: actual, expected: STRUCTURE_CARD_REFERENCE_SHA256, version: STRUCTURE_CARD_RENDERER_VERSION });
  });

  it('is a deterministic 1200×630 PNG', () => {
    const first = renderAtlasStructureCardPng(golden);
    const second = renderAtlasStructureCardPng({ ...golden, snapshot: structuredClone(goldenSnapshot), view: structuredClone(goldenView) });
    expect(pngSignatureOk(first)).toBe(true);
    expect(pngDimensions(first)).toEqual({ width: 1200, height: 630 });
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    // The printed names change the pixels; the structure alone does not depend on them.
    expect(Buffer.from(renderAtlasStructureCardPng({ ...golden, label: { owner: 'thiss', repo: 'okie' } })).equals(Buffer.from(first))).toBe(false);
  });

  it('draws the golden system shell, its containers and its L1 peers with their real names', () => {
    const layout = atlasStructureCardLayout(golden);
    const containers = goldenSnapshot.entities.filter(value => value.kind === 'container' && value.parentId === goldenView.rootEntityId).map(value => value.name);
    const peers = goldenSnapshot.entities.filter(value => !value.parentId && value.id !== goldenView.rootEntityId && (value.kind === 'person' || value.kind === 'externalSystem')).map(value => value.name);
    expect(layout.shell.name).toBe(goldenSnapshot.entities.find(value => value.id === goldenView.rootEntityId)!.name);
    expect(new Set(drawnNames(layout))).toEqual(new Set([...containers, ...peers]));
    expect(layout.boxes.filter(box => box.peer).map(box => box.name).sort()).toEqual([...peers].sort());
    expect(layout.hidden).toBe(0);
    expect(layout.more).toBeUndefined();
    for (const box of [layout.shell, ...layout.boxes]) {
      expect(box.label, box.name).toBeDefined();
      expect(labelFromName(box.label!.text, box.name), `${box.label!.text} ← ${box.name}`).toBe(true);
      // Every label sits inside its box, on the card.
      for (const line of box.label!.lines) {
        expect(line.x).toBeGreaterThanOrEqual(box.rect.x);
        expect(line.x + (line.text.length * 6 - 1) * box.label!.scale).toBeLessThanOrEqual(box.rect.x + box.rect.width);
      }
    }
    // Boxes stay on the board, inside the shell unless they are peers.
    for (const box of layout.boxes) {
      expect(box.rect.x).toBeGreaterThanOrEqual(640);
      expect(box.rect.x + box.rect.width).toBeLessThanOrEqual(640 + 496);
      if (!box.peer) {
        expect(box.rect.x).toBeGreaterThanOrEqual(layout.shell.rect.x);
        expect(box.rect.y + box.rect.height).toBeLessThanOrEqual(layout.shell.rect.y + layout.shell.rect.height);
      }
    }
  });

  it('caps the boxes and counts the rest in "+N more", ranking by relation degree', () => {
    const names = Array.from({ length: 20 }, (_, i) => `service-${String(i).padStart(2, '0')}`);
    // service-19 and service-18 carry the most relations, so they are kept.
    const relations: Array<[number, number]> = [[19, 18], [19, 1], [19, 2], [18, 3], [18, 4], [19, 5]];
    const atlas = syntheticAtlas({ containers: names, relations });
    const layout = atlasStructureCardLayout({ ...atlas, label: { owner: 'acme', repo: 'demo' } });
    expect(layout.boxes.length).toBe(STRUCTURE_CARD_MAX_BOXES);
    // 20 containers + 1 peer, 12 drawn.
    expect(layout.hidden).toBe(21 - STRUCTURE_CARD_MAX_BOXES);
    expect(layout.more?.text).toBe(`+${21 - STRUCTURE_CARD_MAX_BOXES} more`);
    expect(drawnNames(layout)).toEqual(expect.arrayContaining(['service-19', 'service-18', 'Postgres']));
    const png = renderAtlasStructureCardPng({ ...atlas, label: { owner: 'acme', repo: 'demo' } });
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
  });

  it('cuts labels that do not fit with "..." and keeps them inside the box', () => {
    const long = 'an-extraordinarily-long-container-name-that-cannot-possibly-fit-in-one-card-box-even-on-two-lines';
    const atlas = syntheticAtlas({ containers: [long, 'api', 'web'] });
    const layout = atlasStructureCardLayout({ ...atlas, label: { owner: 'acme', repo: 'demo' } });
    const box = layout.boxes.find(value => value.name === long)!;
    expect(box.label?.text).toContain('...');
    expect(labelFromName(box.label!.text, long)).toBe(true);
    for (const line of box.label!.lines) expect(line.x + (line.text.length * 6 - 1) * box.label!.scale).toBeLessThanOrEqual(box.rect.x + box.rect.width);
    expect(fitStructureLabel(long, 60, 20, 'center')).toBeUndefined();
    expect(fitStructureLabel('api', 200, 50, 'center')).toEqual({ lines: ['api'], scale: 3, whole: true });
    expect(fitStructureLabel('@scope/plugin-content-docs', 170, 50, 'center', { scales: [2] })).toEqual({ lines: ['plugin-', 'content-docs'], scale: 2, whole: true });
  });

  it('opens a repository with one container into the L3 files compiled inside it', () => {
    const atlas = syntheticAtlas({ containers: ['monolith'], files: 14 });
    const layout = atlasStructureCardLayout({ ...atlas, label: { owner: 'acme', repo: 'demo' } });
    expect(layout.detail).toBe('component');
    const group = layout.boxes.find(box => box.role === 'group');
    expect(group?.name).toBe('monolith');
    const pills = layout.boxes.filter(box => box.role === 'box' && !box.peer);
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.name).toMatch(/^src\/c0\/file\d+\.ts$/);
      expect(pill.rect.x).toBeGreaterThanOrEqual(group!.rect.x);
      expect(pill.rect.y + pill.rect.height).toBeLessThanOrEqual(group!.rect.y + group!.rect.height);
    }
    // Files beyond what the app previews (and the box cap) are counted, not dropped silently.
    expect(layout.hidden).toBeGreaterThan(0);
  });
});
