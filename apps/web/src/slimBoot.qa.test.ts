import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');

describe('CLA-73: slim boot fetches the neighborhood, not the whole snapshot', () => {
  it('boots /r and fixture=scan through neighborhood.json, not snapshot.json', () => {
    expect(main).toContain('tryBootNeighborhoodFixture(');
    expect(main).toContain('fetchScanNeighborhoodHost(');
    expect(main).toContain('bootFocusFromSearch(window.location.search)');
    expect(fixture).toContain("scanObjectPath(slug, 'neighborhood.json'");
    expect(fixture).not.toMatch(/fetchScanNeighborhoodHost[\s\S]*snapshot\.json/u);
  });

  it('lazy-loads excerpts on Source and container subgraphs on Open inside', () => {
    expect(app).toContain('ensureNeighborhood(entityId)');
    expect(app).toContain('ensureExcerpts(selected.id)');
    expect(app).toContain('scanEntityHasChildren(activeSnapshot, selected.id)');
    expect(app).toContain('data-scan-boot={scanFixture?.boot ?? \'\'}');
  });

  it('does not raise the 2000 hang-guard or protobuf the renderer protocol', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(app).not.toMatch(/protobuf|SceneSnapshot rewrite/u);
  });
});
