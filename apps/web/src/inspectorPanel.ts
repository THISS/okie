export const MIN_INSPECTOR_WIDTH = 360;
export const MAX_INSPECTOR_WIDTH = 520;
export const MAX_INSPECTOR_VIEWPORT_RATIO = .46;
export const DEFAULT_INSPECTOR_MIN_WIDTH = 376;
export const DEFAULT_INSPECTOR_MAX_WIDTH = 416;
export const DEFAULT_INSPECTOR_VIEWPORT_RATIO = .28;
export const COMPACT_INSPECTOR_BREAKPOINT = 1_060;

export function inspectorWidthRange(viewportWidth: number) {
  const safeViewport = Math.max(1, viewportWidth);
  return {
    min: MIN_INSPECTOR_WIDTH,
    max: Math.round(Math.max(
      MIN_INSPECTOR_WIDTH,
      Math.min(MAX_INSPECTOR_WIDTH, safeViewport * MAX_INSPECTOR_VIEWPORT_RATIO),
    )),
  };
}

export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const range = inspectorWidthRange(viewportWidth);
  return Math.round(Math.max(range.min, Math.min(range.max, width)));
}

export function defaultInspectorWidth(viewportWidth: number): number {
  if (viewportWidth <= COMPACT_INSPECTOR_BREAKPOINT) return MIN_INSPECTOR_WIDTH;
  return Math.round(Math.max(
    DEFAULT_INSPECTOR_MIN_WIDTH,
    Math.min(DEFAULT_INSPECTOR_MAX_WIDTH, viewportWidth * DEFAULT_INSPECTOR_VIEWPORT_RATIO),
  ));
}

export function inspectorWidthStorageKey(repositoryId: string): string {
  return `okie:inspector-width:${repositoryId}`;
}

export type InspectorTab = 'source' | 'details';
export type InspectorIntent = 'auto' | 'source' | 'details';

export function inspectorTabForEntity(canShowSource: boolean, intent: InspectorIntent = 'auto'): InspectorTab {
  if (intent === 'details') return 'details';
  return canShowSource ? 'source' : 'details';
}
