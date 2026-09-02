import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  atlasCardLayout,
  pngDimensions,
  pngSignatureOk,
  renderAtlasCardPng,
} from './atlasCard';

describe('atlas Open Graph card (CLA-39)', () => {
  it('is a 1200×630 PNG card labeled with owner/repo, not a favicon size', () => {
    const layout = atlasCardLayout({ owner: 'THISS', repo: 'okie' });
    expect(layout.brand).toBe('OKIE');
    expect(layout.title).toBe('THISS/okie');
    expect(layout.subtitle).toMatch(/atlas/i);
    expect(layout.width).toBe(OG_IMAGE_WIDTH);
    expect(layout.height).toBe(OG_IMAGE_HEIGHT);
    expect(OG_IMAGE_WIDTH).toBe(1200);
    expect(OG_IMAGE_HEIGHT).toBe(630);

    const png = renderAtlasCardPng({ owner: 'THISS', repo: 'okie' });
    expect(pngSignatureOk(png)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
    expect(png.byteLength).toBeGreaterThan(4_000);
  });

  it('changes the map preview when the atlas identity changes', () => {
    const dogfood = renderAtlasCardPng({ owner: 'THISS', repo: 'okie' });
    const other = renderAtlasCardPng({ owner: 'acme', repo: 'commerce' });
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(hash(dogfood)).not.toBe(hash(other));
    expect(atlasCardLayout({ owner: 'acme', repo: 'commerce' }).title).toBe('acme/commerce');
  });

  it('does not embed secrets in the PNG bytes', () => {
    const png = renderAtlasCardPng({ owner: 'THISS', repo: 'okie' });
    const latin1 = Buffer.from(png).toString('latin1');
    expect(latin1).not.toMatch(/apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|gho_|ghp_/);
    expect(latin1).not.toContain('okie-test-llm-key');
  });
});
