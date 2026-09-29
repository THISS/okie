import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderAtlasCardPng } from '../../web/src/atlasCard';
import { OG_CARD_CACHE_VERSION } from '../src/share';

/**
 * CLA-269: `/og` cards are cached at the edge for a day under a key carrying OG_CARD_CACHE_VERSION
 * (apps/edge/src/share.ts). The card's pixels come from apps/web/src/atlasCard.ts, so a layout change
 * there without a version bump would keep serving the old cards. These pins tie the two together:
 * when a reference card's bytes change, bump OG_CARD_CACHE_VERSION and update the pins together.
 */
// THISS/okie (one line), a long name on two lines, and an owner ellipsized to fit (the slash kept).
const REFERENCE_CARDS: ReadonlyArray<{ owner: string; repo: string; version: string; sha256: string }> = [
  { owner: 'THISS', repo: 'okie', version: '3', sha256: '2debe0dad0ff8aebf2ade72fe9de0455561a9940fdba140627bbd3629fd6a9e4' },
  { owner: 'excalidraw', repo: 'excalidraw', version: '3', sha256: 'aa829369ec66c3f24855649063adc6bdbb9c3ad0e3a06f7123e36f7a68f3df91' },
  { owner: 'a-very-long-organization-name-that-keeps-going-and-going', repo: 'repo', version: '3', sha256: '3b58b2e93a6007f98b6b661718daabfdce38efad6680aaa04c28a364aab4684e' },
];

/**
 * The card's pixels: its IDAT data inflated (raw filtered scanlines). Hashing these rather than the PNG
 * bytes keeps the pin independent of the zlib build's compressed output (macOS vs CI).
 */
function cardPixels(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.byteLength;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  return new Uint8Array(inflateSync(joined));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('og card cache version (CLA-269)', () => {
  it('pins the reference card pixels to OG_CARD_CACHE_VERSION', async () => {
    const drifted: string[] = [];
    for (const card of REFERENCE_CARDS) {
      const actual = await sha256Hex(cardPixels(renderAtlasCardPng({ owner: card.owner, repo: card.repo })));
      if (actual !== card.sha256) drifted.push(`${card.owner}/${card.repo} now renders sha256 '${actual}'`);
    }
    expect(
      drifted,
      `The /og card pixels changed (${drifted.join('; ')}). Bump OG_CARD_CACHE_VERSION in apps/edge/src/share.ts `
        + 'so the edge cache stops serving cards from the old layout, then update these pins (sha256 and version).',
    ).toEqual([]);
    for (const card of REFERENCE_CARDS) {
      expect(
        card.version,
        `The ${card.owner}/${card.repo} pin was recorded for OG_CARD_CACHE_VERSION '${card.version}', not '${OG_CARD_CACHE_VERSION}': `
          + 'when you bump OG_CARD_CACHE_VERSION, re-pin every reference card to the new version.',
      ).toBe(OG_CARD_CACHE_VERSION);
    }
  });
});
