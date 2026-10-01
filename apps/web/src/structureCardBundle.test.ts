import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadStructureCardRenderer, structureCardBuildOptions } from '../../../scripts/structure-card-bundle.mjs';
import { STRUCTURE_CARD_REFERENCE_INPUT } from './atlasStructureCard';
import { STRUCTURE_CARD_REFERENCE_SHA256, STRUCTURE_CARD_RENDERER_VERSION } from './atlasStructureCardVersion';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * CLA-319: scripts/publish-atlas.mjs stores cards rendered by THIS esbuild bundle, not by the vitest transform, so the
 * bundle itself must load in plain Node and pass the same pixel self-check the pin test uses.
 */
describe('structure card Node bundle (CLA-319)', () => {
  it('bundles for plain Node, exposes render/version/selfCheck, passes the self-check and cleans up', async () => {
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('okie-structure-card-')));
    const loaded = await loadStructureCardRenderer(repoRoot);
    expect(loaded.version).toBe(STRUCTURE_CARD_RENDERER_VERSION);
    expect(typeof loaded.render).toBe('function');
    expect(loaded.selfCheck()).toEqual({ ok: true, sha256: STRUCTURE_CARD_REFERENCE_SHA256, expected: STRUCTURE_CARD_REFERENCE_SHA256, version: STRUCTURE_CARD_RENDERER_VERSION });
    const png = loaded.render(STRUCTURE_CARD_REFERENCE_INPUT);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const after = readdirSync(tmpdir()).filter(name => name.startsWith('okie-structure-card-') && !before.has(name));
    expect(after, 'the temporary bundle directory is removed').toEqual([]);
    const options = structureCardBuildOptions(repoRoot, '/x/out.mjs');
    expect(options).toMatchObject({ bundle: true, platform: 'node', format: 'esm', target: 'node22' });
    expect(existsSync((options.entryPoints as string[])[0]!)).toBe(true);
  }, 60_000);

  it('removes the temporary directory when the bundle fails', async () => {
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('okie-structure-card-')));
    await expect(loadStructureCardRenderer('/definitely/not/a/repo')).rejects.toThrow();
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('okie-structure-card-') && !before.has(name))).toEqual([]);
  });
});
