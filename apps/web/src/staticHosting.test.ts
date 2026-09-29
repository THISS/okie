import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAND_COST_HANG_GUARD_ENTITIES } from '@okie/scene-compiler';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { WEBMCP_HOST_HEADERS } from './webmcpHeaders';

/** Cloudflare `_headers`: an unindented URL pattern, then indented `Name: value` lines. */
function parseHeadersFile(text: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = {};
      rules.set(line.trim(), current);
      continue;
    }
    const [name, ...rest] = line.trim().split(':');
    if (current && name) current[name.trim()] = rest.join(':').trim();
  }
  return rules;
}

const headersFile = parseHeadersFile(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
const wrangler = readFileSync(new URL('../../edge/wrangler.jsonc', import.meta.url), 'utf8');

describe('CLA-266 Cloudflare static hosting', () => {
  it('keeps the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
  });

  it('retires the Vercel stand-ins and the Pages-style _redirects', () => {
    for (const path of ['../vercel.json', '../../../vercel.json', '../api', '../../../api', '../public/_redirects']) {
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
    }
  });

  it('applies the WebMCP host headers to static assets like the old vercel.json table', () => {
    expect(headersFile.get('/*')).toEqual({ 'Permissions-Policy': WEBMCP_HOST_HEADERS['Permissions-Policy'] });
    for (const shell of ['/', '/new', '/index.html']) {
      expect(headersFile.get(shell), shell).toEqual({ 'Origin-Agent-Cluster': WEBMCP_HOST_HEADERS['Origin-Agent-Cluster'] });
    }
    for (const [pattern, headers] of headersFile) {
      expect(headers['Permissions-Policy'] ?? 'tools=(self)', pattern).toBe('tools=(self)');
      expect(headers['Origin-Agent-Cluster'] ?? '?1', pattern).toBe('?1');
    }
  });

  it('caches content-hashed /assets/* forever', () => {
    expect(headersFile.get('/assets/*')).toEqual({ 'Cache-Control': 'public, max-age=31536000, immutable' });
  });

  it('serves /r and /new as the SPA shell and hands share routes to the Worker', () => {
    expect(wrangler).toMatch(/"not_found_handling":\s*"single-page-application"/);
    // Every path runs the Worker first (share routes, /scan, /api, the www → apex redirect, and the
    // 404 for a missing /assets/* chunk instead of the SPA shell; run_worker_first cannot be host-specific).
    expect(wrangler).toContain('"run_worker_first": true');
  });
});
