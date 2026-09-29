import { shouldShowMobileNotice, type MobileGateInput } from './mobileGate';
import { isKnownAppPath } from './notFoundPage';
import { isPortableMode } from './portable/runtime';
import { parseAppRoute, type AppRoute } from './renderer/route';

/**
 * What main.tsx mounts for a page load (CLA-318), as a pure decision so its ordering is tested:
 *
 *   portable      self-hosted portable viewer (`?portable=1` or the okie-portable marker); nothing else applies
 *   operator      `/operator` (or `/operator/`)
 *   notFound      a path the SPA does not route (in-app 404)
 *   landing       `/new`
 *   mobileNotice  an atlas route on a touch-primary small screen, outside embeds, not yet dismissed;
 *                 "Continue anyway" then boots the `atlas` plan for the same route
 *   atlas         `/r/<owner>/<repo>` or the query-driven flows on `/`
 *
 * The small-screen gate only ever applies to an atlas route: never to portable, operator, 404 or landing.
 */
export type BootPlan =
  | { kind: 'portable' }
  | { kind: 'operator' }
  | { kind: 'notFound' }
  | { kind: 'landing' }
  | { kind: 'mobileNotice'; route: AppRoute }
  | { kind: 'atlas'; route: AppRoute };

export type BootPlanInput = {
  pathname: string;
  search: string;
  /** `<meta name="okie-portable" content="true">` present in the shell. */
  portableMarker: boolean;
  gate: MobileGateInput;
};

export function isOperatorPath(pathname: string): boolean {
  return pathname === '/operator' || pathname === '/operator/';
}

export function bootPlan(input: BootPlanInput): BootPlan {
  if (isPortableMode(input.search, input.portableMarker)) return { kind: 'portable' };
  if (isOperatorPath(input.pathname)) return { kind: 'operator' };
  if (!isKnownAppPath(input.pathname)) return { kind: 'notFound' };
  const route = parseAppRoute(input.pathname);
  if (route.kind === 'landing') return { kind: 'landing' };
  if (shouldShowMobileNotice(input.gate)) return { kind: 'mobileNotice', route };
  return { kind: 'atlas', route };
}
