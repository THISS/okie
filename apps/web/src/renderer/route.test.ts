import { describe, expect, it } from 'vitest';
import { parseAppRoute, repoSlugFor, scanSlug } from './route';

describe('clean-path app routes', () => {
  it('routes /new to the paste-a-repo landing', () => {
    expect(parseAppRoute('/new')).toEqual({ kind: 'landing' });
    expect(parseAppRoute('/new/')).toEqual({ kind: 'landing' });
  });

  it('routes /r/<owner>/<repo> to that repository slug', () => {
    expect(parseAppRoute('/r/colinhacks/zod')).toEqual({
      kind: 'repo',
      owner: 'colinhacks',
      repo: 'zod',
      slug: 'colinhacks__zod',
    });
  });

  it('carries a ref segment (including nested refs) as a pin', () => {
    expect(parseAppRoute('/r/colinhacks/zod/v3')).toMatchObject({ kind: 'repo', ref: 'v3' });
    expect(parseAppRoute('/r/colinhacks/zod/release/v4')).toMatchObject({ kind: 'repo', ref: 'release/v4' });
  });

  it('leaves everything else on the query-driven default flow', () => {
    for (const path of ['/', '/index.html', '/r', '/r/only-owner', '/embed/r/a/b', '/new/extra']) {
      expect(parseAppRoute(path).kind).toBe('default');
    }
  });

  it('rejects owner/repo segments outside the GitHub-legal character set', () => {
    expect(parseAppRoute('/r/own er/repo').kind).toBe('default');
    expect(parseAppRoute('/r/owner/re<po').kind).toBe('default');
  });

  it('mirrors the scanner slug rules so /r paths resolve published slugs', () => {
    // Same cases the scanner derives: lowercase, camelCase split, non-alnum runs → hyphen.
    expect(scanSlug('colinhacks')).toBe('colinhacks');
    expect(scanSlug('My.Repo_Name')).toBe('my-repo-name');
    expect(scanSlug('WASMBridge')).toBe('wasm-bridge');
    expect(repoSlugFor('lukeed', 'clsx')).toBe('lukeed__clsx');
    // Idempotent on its own output — slugified links round-trip through /r/….
    expect(scanSlug(scanSlug('My.Repo_Name'))).toBe('my-repo-name');
  });
});
