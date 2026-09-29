import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CARD_BOARD,
  CARD_TEXT_MAX_WIDTH,
  CARD_TEXT_X,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  atlasCardLayout,
  cardTextWidth,
  pngDimensions,
  pngSignatureOk,
  renderAtlasCardPng,
} from './atlasCard';

describe('atlas Open Graph card (CLA-39)', () => {
  it('is a 1200×630 PNG card labeled with owner/repo, not a favicon size', () => {
    const layout = atlasCardLayout({ owner: 'THISS', repo: 'okie' });
    expect(layout.brand).toBe('SOURCE FOR');
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

  it('fits long owner/repo names inside the text column (CLA-269)', () => {
    const long = atlasCardLayout({ owner: 'excalidraw', repo: 'excalidraw' });
    expect(long.title).toBe('excalidraw/excalidraw');
    expect(long.titleLines.map(line => line.text).join('')).toBe('excalidraw/excalidraw');
    const huge = atlasCardLayout({ owner: 'a-very-long-organization-name-here', repo: 'an-even-longer-repository-name-that-goes-on-and-on-forever' });
    expect(huge.titleLines).toHaveLength(2);
    expect(huge.titleLines[1]!.text.endsWith('...')).toBe(true);
    const short = atlasCardLayout({ owner: 'THISS', repo: 'okie' });
    expect(short.titleLines).toEqual([{ text: 'THISS/okie', scale: 6, y: 250 }]);
    for (const layout of [long, huge, short]) {
      for (const line of layout.titleLines) expect(cardTextWidth(line.text, line.scale)).toBeLessThanOrEqual(CARD_TEXT_MAX_WIDTH);
      expect(layout.subtitleY).toBeLessThan(OG_IMAGE_HEIGHT - 60);
    }
  });

  it('keeps the slash after an ellipsized owner (CLA-269)', () => {
    const layout = atlasCardLayout({ owner: 'a-very-long-organization-name-that-keeps-going-and-going', repo: 'repo' });
    expect(layout.titleLines).toHaveLength(2);
    const [first, second] = layout.titleLines;
    expect(first!.text.endsWith('.../')).toBe(true);
    expect(first!.text.startsWith('a-very-long-organization')).toBe(true);
    expect(cardTextWidth(first!.text, first!.scale)).toBeLessThanOrEqual(CARD_TEXT_MAX_WIDTH);
    expect(second!.text).toBe('repo');
    // An owner that fits keeps its full name and slash.
    expect(atlasCardLayout({ owner: 'excalidraw', repo: 'excalidraw' }).titleLines[0]!.text).toBe('excalidraw/');
  });

  it('never paints title pixels past the text column (CLA-269)', () => {
    const inBoard = (x: number, y: number) =>
      x >= CARD_BOARD.x && x < CARD_BOARD.x + CARD_BOARD.width && y >= CARD_BOARD.y && y < CARD_BOARD.y + CARD_BOARD.height;
    const names = [
      { owner: 'excalidraw', repo: 'excalidraw' },
      { owner: 'a-very-long-organization-name-here', repo: 'an-even-longer-repository-name-that-goes-on-and-on-forever' },
    ];
    for (const name of names) {
      const png = Buffer.from(renderAtlasCardPng(name));
      const at = png.indexOf('IDAT');
      const raw = inflateSync(png.subarray(at + 4, at + 4 + png.readUInt32BE(at - 4)));
      const stride = 1 + OG_IMAGE_WIDTH * 4;
      let titlePixels = 0;
      let maxX = 0;
      // Every pixel outside the map board: the full width and height, not just the left column.
      for (let y = 0; y < OG_IMAGE_HEIGHT; y += 1) {
        for (let x = 0; x < OG_IMAGE_WIDTH; x += 1) {
          if (inBoard(x, y)) continue;
          const i = y * stride + 1 + x * 4;
          if (raw[i] === 241 && raw[i + 1] === 247 && raw[i + 2] === 244) {
            titlePixels += 1;
            maxX = Math.max(maxX, x);
          }
        }
      }
      expect(titlePixels, name.owner).toBeGreaterThan(0);
      expect(maxX, name.owner).toBeLessThan(CARD_TEXT_X + CARD_TEXT_MAX_WIDTH);
    }
  });
});
