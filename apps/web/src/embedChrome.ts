import { isFramedBrowsingContext } from './embedCanvas';
import { OEMBED_EMBED_PARAM } from './oembed';
import { SITE_HOME_HREF, SITE_HOME_LABEL } from './siteMeta';

/**
 * CLA-85: default oEmbed is 800×560. The inspector becomes a 94vw overlay at
 * `@media (max-width: 900px)`, but used to auto-open above 780px — so the
 * Overview architecture brief covered the L1 map. Overlay width is the open/close gate.
 */
export const INSPECTOR_OVERLAY_MAX_WIDTH = 900;

export type EmbedChromeInput = {
  framed?: boolean;
  embedQuery?: boolean;
};

export function isEmbedQueryFlag(search: string): boolean {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(raw).get(OEMBED_EMBED_PARAM) === '1';
}

export function isEmbedChrome(input: EmbedChromeInput): boolean {
  return Boolean(input.framed || input.embedQuery);
}

/** Inspector starts open only when it can sit beside the map, not overlay it. */
export function shouldAutoOpenInspector(input: {
  width: number;
  framed?: boolean;
  embedQuery?: boolean;
}): boolean {
  if (input.width <= INSPECTOR_OVERLAY_MAX_WIDTH) return false;
  if (isEmbedChrome({ framed: input.framed, embedQuery: input.embedQuery })) return false;
  return true;
}

export function initialInspectorOpen(
  win: { innerWidth: number; self?: unknown; top?: unknown } = window,
  search = typeof window === 'undefined' ? '' : window.location.search,
): boolean {
  return shouldAutoOpenInspector({
    width: win.innerWidth,
    framed: isFramedBrowsingContext(win as { self: unknown; top: unknown }),
    embedQuery: isEmbedQueryFlag(search),
  });
}

export type BrandHomeLinkProps = {
  href: string;
  'aria-label': string;
  target?: '_blank';
  rel?: string;
};

/**
 * CLA-269: the atlas header's brand mark + wordmark links home (`/`). Inside an embed (framed or
 * `?embed=1`) the header is still shown, so the link opens the site in a new top-level tab without an
 * opener (like the attribution strip's external links) instead of navigating the host's iframe.
 * `win`/`search` default to the live window (App.tsx calls it bare), like {@link initialInspectorOpen}.
 */
export function brandHomeLinkProps(
  win: { self?: unknown; top?: unknown } = window,
  search = typeof window === 'undefined' ? '' : window.location.search,
): BrandHomeLinkProps {
  const embedded = isEmbedChrome({
    framed: isFramedBrowsingContext(win as { self: unknown; top: unknown }),
    embedQuery: isEmbedQueryFlag(search),
  });
  const props: BrandHomeLinkProps = { href: SITE_HOME_HREF, 'aria-label': SITE_HOME_LABEL };
  return embedded ? { ...props, target: '_blank', rel: 'noopener noreferrer' } : props;
}
