import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  sliceArchitectureNeighborhood,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from './entityExplorer';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import { semanticLevelSession } from './semantic/semanticLensEngine';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('CLA-78: Code rail after Open inside a container', () => {
  it('fetches the L4 neighborhood before the level rail compiles', () => {
    expect(app).toContain('function selectLevel(');
    expect(app).toContain('function selectLevelLoaded(');
    expect(app).toContain('void scanFixture.ensureNeighborhood(initialFocus)');
    expect(app).toContain('return scanFixture.ensureNeighborhood(compileFocus)');
    expect(app).toContain('.then(() => selectLevelLoaded(index))');
  });

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('after Open inside a container, switching to Code yields L4 entities (explorer count > 0)', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    expect(fixture.snapshot.entities.some(entity => entity.kind === 'code')).toBe(false);

    await fixture.ensureNeighborhood('container:web-app');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = fixture.createScene(l3Focus);
    expect((l3.projection?.entityIdsByDetail.component ?? []).length).toBeGreaterThan(0);
    expect(l3.projection?.entityIdsByDetail.code ?? []).toEqual([]);

    const containerCompile = fixture.createScene('container:web-app');
    expect(containerCompile.projection?.entityIdsByDetail.code ?? []).toEqual([]);

    const l4Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'code',
      fixture.navigation.rootEntityId,
    );
    expect(l4Focus).not.toBe('container:web-app');
    expect(fixture.snapshot.entities.find(entity => entity.id === l4Focus)?.kind).toBe('component');
    expect(fixture.snapshot.entities.find(entity => entity.id === l4Focus)?.parentId).toBe('container:web-app');

    await fixture.ensureNeighborhood(l4Focus);
    expect(fixture.snapshot.entities.some(entity => entity.kind === 'code' && entity.parentId === l4Focus)).toBe(true);

    const l4 = fixture.createScene(l4Focus);
    const codeIds = l4.projection?.entityIdsByDetail.code ?? [];
    expect(codeIds.length).toBeGreaterThan(0);
    expect(l4.entities.some(entity => entity.detail === 'code' && codeIds.includes(entity.id))).toBe(true);

    const selected = l4.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(l4, 'code', ['container:web-app']);
    const rows = explorerEntitiesForView(l4, {
      detail: 'code',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: codeIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(entity => codeIds.includes(entity.id))).toBe(true);
  });

  it('keeps Open-inside a file compiling that file’s L4 symbols', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    await fixture.ensureNeighborhood('component:web-shell');
    const focus = scanCompileFocusForBand(
      fixture.snapshot,
      'component:web-shell',
      'code',
      fixture.navigation.rootEntityId,
    );
    expect(focus).toBe('component:web-shell');
    const scene = fixture.createScene(focus);
    expect((scene.projection?.entityIdsByDetail.code ?? []).length).toBeGreaterThan(0);
    const selected = scene.entities.find(entity => entity.id === 'component:web-shell');
    expect(selected).toBeDefined();
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: selected!,
      visibleIds: scene.projection?.entityIdsByDetail.code,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(entity => entity.id === 'code:web-shell:app' || entity.detail === 'code')).toBe(true);
  });
});
