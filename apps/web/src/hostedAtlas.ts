import { parseAppRoute, scanSlug, type AppRoute } from './renderer/route';

/**
 * THISS/okie is the dogfood public atlas (CLA-30). `/r/THISS/okie` must load
 * without a login wall: published scan first, then the bundled self-scan, then
 * the golden demo that `/` already renders.
 */
export const DOGFOOD_ATLAS_OWNER = 'THISS';
export const DOGFOOD_ATLAS_REPO = 'okie';
export const DOGFOOD_ATLAS_SLUG = `${scanSlug(DOGFOOD_ATLAS_OWNER)}__${scanSlug(DOGFOOD_ATLAS_REPO)}`;

export type HostedAtlasBootStep =
  | { kind: 'fetch'; slug: string }
  | { kind: 'bundled'; slug?: string }
  | { kind: 'golden' };

export function isDogfoodAtlas(owner: string, repo: string): boolean {
  return scanSlug(owner) === scanSlug(DOGFOOD_ATLAS_OWNER)
    && scanSlug(repo) === scanSlug(DOGFOOD_ATLAS_REPO);
}

/**
 * Ordered load attempts for a public `/r/<owner>/<repo>` URL. Non-dogfood
 * repos are fetch-only (a 404 is a closed miss). Dogfood always ends on the
 * golden demo so the share URL cannot 404 this product.
 */
export function hostedAtlasBootPlan(
  route: AppRoute,
  options: { bundledSlugs?: readonly string[] } = {},
): HostedAtlasBootStep[] {
  if (route.kind !== 'repo') return [];
  const { slug, owner, repo } = route;
  if (!isDogfoodAtlas(owner, repo)) return [{ kind: 'fetch', slug }];

  const steps: HostedAtlasBootStep[] = [{ kind: 'fetch', slug }];
  const bundled = options.bundledSlugs ?? [];
  if (bundled.includes(slug)) steps.push({ kind: 'bundled', slug });
  steps.push({ kind: 'bundled' });
  steps.push({ kind: 'golden' });
  return steps;
}

/** True when this pathname is a public atlas view (no paste form, no login). */
export function isPublicAtlasViewPath(pathname: string): boolean {
  return parseAppRoute(pathname).kind === 'repo';
}
