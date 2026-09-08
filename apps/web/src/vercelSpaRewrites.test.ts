import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAND_COST_HANG_GUARD_ENTITIES } from '@okie/scene-compiler';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';

type VercelConfig = {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  rewrites: Array<{ source: string; destination: string }>;
};

const webVercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as VercelConfig;
const rootVercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as VercelConfig;

/**
 * Minimal Vercel `source` matcher for the checked-in rewrite table.
 * `:name` = one path segment, `:name*` = the rest of the path.
 */
function matchVercelSource(source: string, pathname: string): boolean {
  const replacements: string[] = [];
  const tokenized = source.replace(/:([A-Za-z0-9_]+)\*|:([A-Za-z0-9_]+)/g, (_all, starName) => {
    replacements.push(starName !== undefined ? '.*' : '[^/]+');
    return `§${replacements.length - 1}§`;
  });
  const escaped = tokenized.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/§(\d+)§/g, (_, index) => replacements[Number(index)]!);
  return new RegExp(`^${pattern}$`).test(pathname);
}

function vercelRewriteDestination(
  pathname: string,
  rewrites: Array<{ source: string; destination: string }>,
): string | undefined {
  const rule = rewrites.find(entry => matchVercelSource(entry.source, pathname));
  return rule?.destination;
}

describe('CLA-116 Vercel SPA rewrites', () => {
  it('keeps the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
  });

  it('keeps root and apps/web vercel.json rewrite tables in lockstep', () => {
    expect(rootVercel.rewrites).toEqual(webVercel.rewrites);
    expect(rootVercel.headers).toEqual(webVercel.headers);
  });

  it('serves /r /new as the SPA shell and /oembed /og as functions', () => {
    expect(webVercel.rewrites).toEqual([
      { source: '/oembed', destination: '/api/oembed' },
      { source: '/og/:owner/:repo', destination: '/api/og?owner=:owner&repo=:repo' },
      { source: '/r/:path*', destination: '/index.html' },
      { source: '/new', destination: '/index.html' },
    ]);
  });

  it('rewrites the hosted share, landing, and oEmbed paths instead of 404', () => {
    const { rewrites } = webVercel;
    expect(vercelRewriteDestination('/r/THISS/okie', rewrites)).toBe('/index.html');
    expect(vercelRewriteDestination('/r/THISS/okie/main', rewrites)).toBe('/index.html');
    expect(vercelRewriteDestination('/new', rewrites)).toBe('/index.html');
    expect(vercelRewriteDestination('/oembed', rewrites)).toBe('/api/oembed');
    expect(vercelRewriteDestination('/og/THISS/okie', rewrites)).toBe('/api/og?owner=:owner&repo=:repo');
    expect(vercelRewriteDestination('/', rewrites)).toBeUndefined();
    expect(vercelRewriteDestination('/api/scans', rewrites)).toBeUndefined();
    expect(vercelRewriteDestination('/scan/thiss__okie/snapshot.json', rewrites)).toBeUndefined();
  });

  it('does not send /r share URLs through a missing /api/share destination', () => {
    expect(webVercel.rewrites.some(rule => rule.source.startsWith('/r/') && rule.destination.includes('/api/share'))).toBe(false);
  });

  it('re-exports Node handlers from repo-root /api so Root Directory=. can serve oEmbed', () => {
    const oembed = readFileSync(new URL('../../../api/oembed.ts', import.meta.url), 'utf8');
    const og = readFileSync(new URL('../../../api/og.ts', import.meta.url), 'utf8');
    const share = readFileSync(new URL('../../../api/share.ts', import.meta.url), 'utf8');
    expect(oembed).toContain("from '../apps/web/api/oembed.ts'");
    expect(og).toContain("from '../apps/web/api/og.ts'");
    expect(share).toContain("from '../apps/web/api/share.ts'");
    expect(`${oembed}\n${og}\n${share}`).not.toMatch(/OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN|apiKey/);
  });
});
