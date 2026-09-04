import { sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';
import { describe, expect, it } from 'vitest';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, compileScanNeighborhoodFixture, fetchScanNeighborhoodHost, fetchScanTrioLoader, loadScanFixture, resolveScanDocLoader, ScanFixtureError, bootFocusFromSearch, type ScanTrioLoader } from './scanFixture';

function validTrio() {
  return {
    snapshot: structuredClone(demoSnapshot),
    view: structuredClone(demoView),
    story: structuredClone(demoStory),
  };
}

describe('scan fixture loader', () => {
  it('compiles a valid trio into a live scene + story via the demo compile path', () => {
    const fixture = compileScanFixture(validTrio());
    expect(fixture.story.steps.length).toBeGreaterThan(0);
    expect(fixture.navigation.rootEntityId).toBe(demoView.rootEntityId);
    expect(fixture.navigation.snapshotId).toBe(demoSnapshot.id);

    const scene = fixture.createScene(fixture.navigation.rootEntityId);
    expect(scene.entities).toHaveLength(demoSnapshot.entities.length);
    expect(scene.projection).toBeDefined();
    expect(scene.protocolSnapshot).toBeDefined();

    // Re-focus recompiles the SAME scanned snapshot (not the golden one).
    const refocused = fixture.createScene(scene.entities[1]!.id, scene);
    expect(refocused.id).toBe(scene.id);
    expect(refocused.entities).toHaveLength(demoSnapshot.entities.length);

    // Hang-guard is a no-op on the demo-sized snapshot; per-kind maxBand still
    // scopes the root compile (CLA-66) so L1 stays a handful, not every L4 row.
    expect(fixture.createScene(fixture.navigation.rootEntityId).scanGuardRefusal).toBeUndefined();
    expect(refocused.scanGuardRefusal).toBeUndefined();
    expect(fixture.scopeCompileOptions(fixture.navigation.rootEntityId)).toEqual({ maxBand: 'container' });
    expect(scene.projection?.entityIdsByDetail.component ?? []).toEqual([]);
    expect(scene.projection?.entityIdsByDetail.code ?? []).toEqual([]);
  });


  it('applies the mode-level aspect target below the scoped-compile size gate (task #30)', () => {
    const base = compileScanFixture(validTrio());
    const landscape = compileScanFixture(validTrio(), { targetAspect: 1.6 });
    // Aspect is a per-mode compile input at every repo size, independent of the
    // hang-guard entity count. Per-kind maxBand still scopes the root (CLA-66).
    expect(landscape.targetAspect).toBe(1.6);
    expect(base.targetAspect).toBeUndefined();
    const root = base.navigation.rootEntityId;
    const off = JSON.stringify(base.createScene(root).protocolSnapshot);
    const on = JSON.stringify(landscape.createScene(root).protocolSnapshot);
    expect(on).not.toEqual(off);
    expect(landscape.scopeCompileOptions(root)).toEqual({ maxBand: 'container' });
  });


  it('throws ScanFixtureError listing issues for an invalid snapshot', () => {
    const trio = validTrio();
    const entities = (trio.snapshot as { entities: unknown[] }).entities;
    entities.push(entities[0]); // duplicate entity id
    let caught: unknown;
    try { compileScanFixture(trio); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ScanFixtureError);
    expect((caught as ScanFixtureError).issues.some(issue => /duplicate entity id/u.test(issue.message))).toBe(true);
    expect((caught as ScanFixtureError).issues[0]!.path).toMatch(/^snapshot\./u);
  });

  it('never accepts a non-object document silently', () => {
    expect(() => compileScanFixture({ snapshot: null, view: demoView, story: demoStory })).toThrow(/must be a JSON object/u);
  });

  it('rejects via the loader when a fetched document is structurally invalid', async () => {
    const load: ScanTrioLoader = async name =>
      name === 'snapshot' ? { not: 'a snapshot' } : name === 'view' ? demoView : demoStory;
    await expect(loadScanFixture(load)).rejects.toBeInstanceOf(ScanFixtureError);
  });
});

describe('multi-repo scan doc resolution', () => {
  // Fake glob maps standing in for import.meta.glob's build-time output.
  const marker = (label: string) => () => Promise.resolve({ default: label });
  const root = {
    '../../../../fixtures/scan/snapshot.json': marker('root-snapshot'),
    '../../../../fixtures/scan/view.json': marker('root-view'),
    '../../../../fixtures/scan/story.json': marker('root-story'),
  };
  const repo = {
    '../../../../fixtures/scan/colinhacks__zod/snapshot.json': marker('zod-snapshot'),
    '../../../../fixtures/scan/colinhacks__zod/view.json': marker('zod-view'),
    '../../../../fixtures/scan/colinhacks__zod/story.json': marker('zod-story'),
    '../../../../fixtures/scan/acme__app/snapshot.json': marker('app-snapshot'),
    '../../../../fixtures/scan/acme__app/view.json': marker('app-view'),
    '../../../../fixtures/scan/acme__app/story.json': marker('app-story'),
  };

  it('no slug resolves the root self-scan trio (back-compat path unchanged)', async () => {
    expect((await resolveScanDocLoader('snapshot', undefined, { root, repo })()).default).toBe('root-snapshot');
    expect((await resolveScanDocLoader('view', undefined, { root, repo })()).default).toBe('root-view');
    // The root resolver never crosses into a per-repo directory.
    expect((await resolveScanDocLoader('story', undefined, { root, repo: {} })()).default).toBe('root-story');
  });

  it('a slug selects exactly that repo directory', async () => {
    expect((await resolveScanDocLoader('snapshot', 'colinhacks__zod', { root, repo })()).default).toBe('zod-snapshot');
    expect((await resolveScanDocLoader('view', 'acme__app', { root, repo })()).default).toBe('app-view');
  });

  it('fails closed on an unknown slug, listing the available slugs sorted', () => {
    try {
      resolveScanDocLoader('snapshot', 'missing__repo', { root, repo });
      throw new Error('expected a ScanFixtureError');
    } catch (error) {
      expect(error).toBeInstanceOf(ScanFixtureError);
      const message = (error as ScanFixtureError).issues[0]!.message;
      expect(message).toContain('No scanned repository “missing__repo”');
      expect(message).toContain('acme__app, colinhacks__zod');
    }
  });

  it('reports an incomplete slug directory distinctly from an unknown one', () => {
    const partial = { '../../../../fixtures/scan/half__done/snapshot.json': marker('x') };
    expect(() => resolveScanDocLoader('view', 'half__done', { root, repo: partial })).toThrow(/missing view\.json/u);
  });

  it('fails closed with guidance when no repos are available at all', () => {
    expect(() => resolveScanDocLoader('snapshot', 'anything', { root, repo: {} })).toThrow(/none are available/u);
  });
});

describe('runtime-fetch scan trio loader (hosted /r URLs)', () => {
  it('GETs /scan/<slug>/{name}.json and compiles nothing itself', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ ok: url }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const load = fetchScanTrioLoader('thiss__okie', fetchImpl);
    expect(await load('snapshot')).toEqual({ ok: '/scan/thiss__okie/snapshot.json' });
    expect(await load('view')).toEqual({ ok: '/scan/thiss__okie/view.json' });
    expect(calls).toEqual([
      '/scan/thiss__okie/snapshot.json',
      '/scan/thiss__okie/view.json',
    ]);
  });

  it('fails closed on 404 without putting tokens in the message', async () => {
    const load = fetchScanTrioLoader('acme__app', async () => new Response('nope', { status: 404 }));
    try {
      await load('story');
      throw new Error('expected ScanFixtureError');
    } catch (error) {
      expect(error).toBeInstanceOf(ScanFixtureError);
      const message = (error as ScanFixtureError).issues[0]!.message;
      expect(message).toContain('/scan/acme__app/story.json');
      expect(message).not.toMatch(/gho_|ghp_|github_pat_|Bearer /u);
    }
  });
});

describe('CLA-73 slim neighborhood boot', () => {
  it('reads sel from the share URL for the boot focus', () => {
    expect(bootFocusFromSearch('?sel=container:web-app&detail=component')).toBe('container:web-app');
    expect(bootFocusFromSearch('?root=system:okie&lens=container:web-app')).toBe('container:web-app');
    expect(bootFocusFromSearch('?nav=1')).toBeUndefined();
  });

  it('GETs neighborhood.json + story.json, never snapshot.json', async () => {
    const calls: string[] = [];
    const packet = sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    );
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.includes('neighborhood.json')) {
        return new Response(JSON.stringify(packet), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('story.json')) {
        return new Response(JSON.stringify(demoStory), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('excerpt.json')) {
        return new Response(JSON.stringify({ kind: 'excerpt', schemaVersion: 1, entityId: 'x', sourceExcerpts: [] }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    };
    const host = fetchScanNeighborhoodHost('thiss__okie', fetchImpl);
    await host.loadNeighborhood('system:okie');
    await host.loadStory();
    expect(calls.some(url => url.includes('neighborhood.json') && url.includes('focus=system%3Aokie'))).toBe(true);
    expect(calls).toContain('/scan/thiss__okie/story.json');
    expect(calls.some(url => url.includes('snapshot.json'))).toBe(false);
    expect(calls.some(url => url.includes('view.json'))).toBe(false);
  });

  it('compiles an L1 neighborhood without L4 excerpts and still lazy-loads Source', async () => {
    const packet = sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    );
    expect(packet.snapshot.entities.some(entity => entity.kind === 'code')).toBe(false);
    expect(packet.snapshot.entities.some(entity => entity.sourceExcerpts?.length)).toBe(false);
    const excerpts = [{
      path: 'apps/web/src/App.tsx',
      language: 'tsx' as const,
      startLine: 1,
      endLine: 2,
      highlightLine: 1,
      frozenRevision: 'sha',
      lines: ['export function App() {', '}'],
      text: 'export function App() {\n}',
    }];
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
        structuredClone(demoView) as unknown as ArchitectureView,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => excerpts,
      loadStory: async () => demoStory,
    };
    const fixture = compileScanNeighborhoodFixture(packet, demoStory, host);
    expect(fixture.boot).toBe('neighborhood');
    expect(fixture.childCounts['container:web-app']).toBeGreaterThan(0);
    const scene = fixture.createScene(fixture.navigation.rootEntityId);
    expect(scene.entities.some(entity => entity.kind === 'container')).toBe(true);
    expect(scene.entities.some(entity => entity.detail === 'code')).toBe(false);

    await fixture.ensureNeighborhood('container:web-app');
    expect(fixture.snapshot.entities.some(entity => entity.id === 'component:web-shell')).toBe(true);

    const loaded = await fixture.ensureExcerpts('code:web-shell:app');
    expect(loaded?.[0]?.text).toContain('export function App()');

    const requested: string[] = [];
    const deepHost = {
      ...host,
      loadNeighborhood: async (focus: string) => {
        requested.push(focus);
        return host.loadNeighborhood(focus);
      },
    };
    const l1 = compileScanNeighborhoodFixture(packet, demoStory, deepHost);
    await l1.ensureNeighborhood('code:web-shell:app');
    expect(requested).toEqual(['code:web-shell:app']);
    expect(l1.snapshot.entities.some(entity => entity.id === 'code:web-shell:app')).toBe(true);
  });

  it('does not raise the 2000 hang-guard', () => {
    const fixture = compileScanFixture(validTrio());
    expect(fixture.boot).toBe('full');
  });
});

