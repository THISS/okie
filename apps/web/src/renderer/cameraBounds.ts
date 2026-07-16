import { C4_CAMERA_LIMITS, C4_ZOOM_BANDS } from '@okie/scene-compiler';

export const ATLAS_CAMERA_BOUNDS = C4_CAMERA_LIMITS;

export type SemanticZoomBand = {
  enterZoom: number;
  focusZoom: number;
  hysteresis: number;
};

export const ATLAS_SEMANTIC_ZOOM_BANDS: readonly SemanticZoomBand[] = C4_ZOOM_BANDS;

export function semanticFocusZooms(
  bands: readonly SemanticZoomBand[] = ATLAS_SEMANTIC_ZOOM_BANDS,
) {
  return bands.map(band => band.focusZoom);
}

export function semanticDominantZoomIntervals(
  bands: readonly SemanticZoomBand[] = ATLAS_SEMANTIC_ZOOM_BANDS,
  bounds: { minZoom: number; maxZoom: number } = ATLAS_CAMERA_BOUNDS,
) {
  return bands.map((band, index) => ({
    min: index === 0 ? bounds.minZoom : band.enterZoom,
    max: bands[index + 1]?.enterZoom !== undefined
      ? Math.round((bands[index + 1]!.enterZoom - 0.001) * 1_000) / 1_000
      : bounds.maxZoom,
  }));
}

/** Resolves a semantic level from the authored handoffs, retaining hysteresis. */
export function semanticLevelAtZoom(
  zoom: number,
  previous?: number,
  bands: readonly SemanticZoomBand[] = ATLAS_SEMANTIC_ZOOM_BANDS,
) {
  const handoffs = bands.slice(1).map(band => band.enterZoom);
  const direct = handoffs.findIndex(handoff => zoom < handoff);
  if (previous === undefined || previous < 0 || previous >= bands.length) {
    return direct < 0 ? Math.max(0, bands.length - 1) : direct;
  }
  let level = previous;
  while (level < bands.length - 1) {
    const next = bands[level + 1];
    if (!next || zoom < next.enterZoom + next.hysteresis) break;
    level += 1;
  }
  while (level > 0) {
    const current = bands[level];
    if (!current || zoom >= current.enterZoom - current.hysteresis) break;
    level -= 1;
  }
  return level;
}

export function clampAtlasCameraZoom(zoom: number) {
  return Math.min(ATLAS_CAMERA_BOUNDS.maxZoom, Math.max(ATLAS_CAMERA_BOUNDS.minZoom, zoom));
}
