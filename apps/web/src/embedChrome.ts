import { isFramedBrowsingContext } from './embedCanvas';
import { OEMBED_EMBED_PARAM } from './oembed';

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
