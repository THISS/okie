import { describe, expect, it } from 'vitest';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, loadScanFixture, ScanFixtureError, type ScanTrioLoader } from './scanFixture';

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
