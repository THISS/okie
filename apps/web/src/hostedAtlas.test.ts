import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOGFOOD_ATLAS_SLUG, hostedAtlasBootPlan, isDogfoodAtlas, isPublicAtlasViewPath } from './hostedAtlas';
import { parseAppRoute } from './renderer/route';

describe('hosted public atlas URLs (CLA-30)', () => {
  it('treats THISS/okie (any GitHub-legal casing) as the dogfood atlas', () => {
    expect(DOGFOOD_ATLAS_SLUG).toBe('thiss__okie');
    expect(isDogfoodAtlas('THISS', 'okie')).toBe(true);
    expect(isDogfoodAtlas('thiss', 'okie')).toBe(true);
    expect(isDogfoodAtlas('Thiss', 'Okie')).toBe(true);
    expect(isDogfoodAtlas('colinhacks', 'zod')).toBe(false);
  });

  it('loads a pasted repo only from the published scan slot', () => {
    expect(hostedAtlasBootPlan(parseAppRoute('/r/colinhacks/zod'))).toEqual([
      { kind: 'fetch', slug: 'colinhacks__zod' },
    ]);
  });

  it('keeps /r/THISS/okie shareable when no hosted scan has been published', () => {
    expect(hostedAtlasBootPlan(parseAppRoute('/r/THISS/okie'))).toEqual([
      { kind: 'fetch', slug: 'thiss__okie' },
      { kind: 'bundled' },
      { kind: 'golden' },
    ]);
  });

  it('prefers a bundled thiss__okie slot when the glob actually built one', () => {
    expect(hostedAtlasBootPlan(parseAppRoute('/r/thiss/okie'), { bundledSlugs: ['thiss__okie'] })).toEqual([
      { kind: 'fetch', slug: 'thiss__okie' },
      { kind: 'bundled', slug: 'thiss__okie' },
      { kind: 'bundled' },
      { kind: 'golden' },
    ]);
  });

  it('does not invent a boot plan for the landing or the default demo', () => {
    expect(hostedAtlasBootPlan(parseAppRoute('/new'))).toEqual([]);
    expect(hostedAtlasBootPlan(parseAppRoute('/'))).toEqual([]);
  });

  it('marks /r/<owner>/<repo> as a public view path (no login wall)', () => {
    expect(isPublicAtlasViewPath('/r/THISS/okie')).toBe(true);
    expect(isPublicAtlasViewPath('/r/colinhacks/zod')).toBe(true);
    expect(isPublicAtlasViewPath('/new')).toBe(false);
    expect(isPublicAtlasViewPath('/')).toBe(false);
  });

  it('boots /r/THISS/okie through the hosted plan in main.tsx (no login gate)', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('hostedAtlasBootPlan');
    expect(main).toMatch(/no login/);
    expect(main).not.toMatch(/LoginScreen|requireAuth|SignInButton/);
  });
});
