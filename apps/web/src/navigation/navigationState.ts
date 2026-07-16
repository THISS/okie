import type { Camera } from '../renderer/types';

export const NAVIGATION_URL_VERSION = 1 as const;
export const MAX_NAVIGATION_QUERY_LENGTH = 4_096;
export const MAX_NAVIGATION_ID_LENGTH = 512;

export type SemanticDetail = 'context' | 'container' | 'component' | 'code';

export type NavigationStoryState = {
  id: string;
  step: number;
  positionMs: number;
};

export type NavigationState = {
  version: typeof NAVIGATION_URL_VERSION;
  repositoryId: string;
  snapshotId: string;
  viewId: string;
  rootEntityId: string;
  selectedId: string;
  camera: Camera;
  detail?: SemanticDetail;
  lensPath?: string[];
  filterId?: string;
  story?: NavigationStoryState;
};

export type NavigationDefaults = Omit<NavigationState, 'version'> & {
  minZoom?: number;
  maxZoom?: number;
};

export type NavigationReferences = {
  hasSnapshot?: (id: string) => boolean;
  hasView?: (id: string) => boolean;
  hasEntity?: (id: string) => boolean;
  hasStory?: (id: string) => boolean;
};

export type NavigationUrlOptions = {
  preserveParams?: readonly string[];
  references?: NavigationReferences;
};

export type NavigationDecodeResult = {
  state: NavigationState;
  canonicalUrl: string;
  warnings: string[];
};

const orderedKeys = [
  'nav', 'repo', 'snap', 'view', 'root', 'sel', 'cx', 'cy', 'z', 'detail', 'lens', 'filter', 'story', 'step', 't',
] as const;
const knownKeys = new Set<string>(orderedKeys);
const details = new Set<SemanticDetail>(['context', 'container', 'component', 'code']);

function normalizeZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function quantize(value: number, scale: number) {
  return normalizeZero(Math.round(value * scale) / scale);
}

function cleanId(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  return candidate && candidate.length <= MAX_NAVIGATION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : fallback;
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= MAX_NAVIGATION_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertWritableId(value: unknown, key: string) {
  if (!isValidId(value)) {
    throw new RangeError(`Navigation ${key} must be 1-${MAX_NAVIGATION_ID_LENGTH} printable characters.`);
  }
}

function cleanInteger(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function canonicalNavigationState(
  value: Partial<NavigationState>,
  defaults: NavigationDefaults,
): NavigationState {
  const minZoom = Number.isFinite(defaults.minZoom) ? Math.max(0.00001, defaults.minZoom!) : 0.00001;
  const maxZoom = Number.isFinite(defaults.maxZoom) ? Math.max(minZoom, defaults.maxZoom!) : 1_000;
  const rawCamera = value.camera ?? defaults.camera;
  const x = Number.isFinite(rawCamera.x) ? rawCamera.x : defaults.camera.x;
  const y = Number.isFinite(rawCamera.y) ? rawCamera.y : defaults.camera.y;
  const rawZoom = Number.isFinite(rawCamera.zoom) ? rawCamera.zoom : defaults.camera.zoom;
  const selectedId = cleanId(value.selectedId, defaults.selectedId || defaults.rootEntityId);
  const detail = value.detail && details.has(value.detail) ? value.detail : defaults.detail;
  const sourceLensPath = value.lensPath ?? defaults.lensPath ?? [];
  const lensPath = sourceLensPath.slice(0, 3).map(id => cleanId(id, '')).filter(Boolean);
  const filterId = value.filterId === undefined
    ? defaults.filterId
    : cleanId(value.filterId, defaults.filterId ?? '');
  const sourceStory = value.story ?? defaults.story;
  const storyId = sourceStory ? cleanId(sourceStory.id, '') : '';
  const story = sourceStory && storyId
    ? {
        id: storyId,
        step: cleanInteger(sourceStory.step, 0),
        positionMs: cleanInteger(sourceStory.positionMs, 0),
      }
    : undefined;

  return {
    version: NAVIGATION_URL_VERSION,
    repositoryId: cleanId(value.repositoryId, defaults.repositoryId),
    snapshotId: cleanId(value.snapshotId, defaults.snapshotId),
    viewId: cleanId(value.viewId, defaults.viewId),
    rootEntityId: cleanId(value.rootEntityId, defaults.rootEntityId),
    selectedId,
    camera: {
      x: quantize(x, 1_000),
      y: quantize(y, 1_000),
      zoom: quantize(Math.min(maxZoom, Math.max(minZoom, rawZoom)), 100_000),
    },
    ...(detail ? { detail } : {}),
    ...(lensPath.length ? { lensPath } : {}),
    ...(filterId ? { filterId } : {}),
    ...(story ? { story } : {}),
  };
}

function formatNumber(value: number) {
  const normalized = normalizeZero(value);
  return Number.isInteger(normalized) ? String(normalized) : String(normalized).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function append(entries: Array<readonly [string, string]>, key: string, value: string | undefined) {
  if (value !== undefined && value !== '') entries.push([key, value]);
}

export function canonicalNavigationUrl(
  value: NavigationState,
  baseUrl: string | URL = window.location.href,
  options: NavigationUrlOptions = {},
) {
  assertWritableId(value.repositoryId, 'repository ID');
  assertWritableId(value.snapshotId, 'snapshot ID');
  assertWritableId(value.viewId, 'view ID');
  assertWritableId(value.rootEntityId, 'root entity ID');
  assertWritableId(value.selectedId, 'selected entity ID');
  if (value.filterId !== undefined) assertWritableId(value.filterId, 'filter ID');
  for (const lensId of value.lensPath ?? []) assertWritableId(lensId, 'lens entity ID');
  if (value.story !== undefined) assertWritableId(value.story.id, 'story ID');

  const url = new URL(baseUrl.toString());
  const entries: Array<readonly [string, string]> = [];
  append(entries, 'nav', String(NAVIGATION_URL_VERSION));
  append(entries, 'repo', value.repositoryId);
  append(entries, 'snap', value.snapshotId);
  append(entries, 'view', value.viewId);
  append(entries, 'root', value.rootEntityId);
  if (value.selectedId !== value.rootEntityId) append(entries, 'sel', value.selectedId);
  append(entries, 'cx', formatNumber(value.camera.x));
  append(entries, 'cy', formatNumber(value.camera.y));
  append(entries, 'z', formatNumber(value.camera.zoom));
  append(entries, 'detail', value.detail);
  for (const lensId of value.lensPath ?? []) append(entries, 'lens', lensId);
  append(entries, 'filter', value.filterId);
  if (value.story) {
    append(entries, 'story', value.story.id);
    append(entries, 'step', String(value.story.step));
    append(entries, 't', String(value.story.positionMs));
  }

  const preserve = [...new Set(options.preserveParams ?? [])].slice(0, 32).sort();
  for (const key of preserve) {
    if (knownKeys.has(key)) continue;
    const values = url.searchParams.getAll(key).slice(0, 32).sort();
    for (const preserved of values) {
      if (preserved.length <= MAX_NAVIGATION_ID_LENGTH) append(entries, key, preserved);
    }
  }

  const query = entries.map(([key, entry]) => `${encode(key)}=${encode(entry)}`).join('&');
  url.search = query;
  if (url.search.length > MAX_NAVIGATION_QUERY_LENGTH) {
    throw new RangeError(`Canonical navigation query exceeds ${MAX_NAVIGATION_QUERY_LENGTH} characters.`);
  }
  url.hash = '';
  return url.toString();
}

function lastParam(params: URLSearchParams, key: string, warnings: string[]) {
  const values = params.getAll(key);
  if (values.length > 1) warnings.push(`Duplicate navigation parameter ${key}; using the last value.`);
  return values.at(-1) ?? undefined;
}

function parseFinite(value: string | undefined, fallback: number, key: string, warnings: string[]) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    warnings.push(`Invalid numeric navigation parameter ${key}; using the default.`);
    return fallback;
  }
  return parsed;
}

function parseInteger(value: string | undefined, fallback: number, key: string, warnings: string[]) {
  const parsed = parseFinite(value, fallback, key, warnings);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    warnings.push(`Invalid integer navigation parameter ${key}; using the default.`);
    return fallback;
  }
  return parsed;
}

function validatedId(
  value: string | undefined,
  fallback: string,
  validate: ((id: string) => boolean) | undefined,
  key: string,
  warnings: string[],
) {
  const candidate = cleanId(value, fallback);
  if (validate && !validate(candidate)) {
    warnings.push(`Unknown ${key} ${candidate}; using the default.`);
    return fallback;
  }
  return candidate;
}

export function navigationStateFromUrl(
  input: string | URL,
  defaults: NavigationDefaults,
  options: NavigationUrlOptions = {},
): NavigationDecodeResult {
  const url = new URL(input.toString(), typeof window === 'undefined' ? 'https://atlas.invalid/' : window.location.href);
  const warnings: string[] = [];
  const queryTooLarge = url.search.length > MAX_NAVIGATION_QUERY_LENGTH;
  if (queryTooLarge) warnings.push(`Navigation query exceeds ${MAX_NAVIGATION_QUERY_LENGTH} characters; using defaults.`);
  const params = queryTooLarge ? new URLSearchParams() : url.searchParams;
  const version = lastParam(params, 'nav', warnings);
  if (version !== undefined && version !== String(NAVIGATION_URL_VERSION)) {
    warnings.push(`Unsupported navigation URL version ${version}; using defaults.`);
  }
  const useParams = version === undefined || version === String(NAVIGATION_URL_VERSION);
  const read = (key: string) => useParams ? lastParam(params, key, warnings) : undefined;
  const references = options.references ?? {};
  const snapshotId = validatedId(read('snap'), defaults.snapshotId, references.hasSnapshot, 'snapshot', warnings);
  const viewId = validatedId(read('view'), defaults.viewId, references.hasView, 'view', warnings);
  const rootEntityId = validatedId(read('root'), defaults.rootEntityId, references.hasEntity, 'root entity', warnings);
  const selectedId = validatedId(read('sel'), rootEntityId, references.hasEntity, 'selected entity', warnings);
  const rawLensPath = useParams ? params.getAll('lens') : [];
  if (rawLensPath.length > 3) warnings.push('Lens path exceeds three semantic levels; ignoring the remainder.');
  const lensPath = rawLensPath.slice(0, 3)
    .map(id => validatedId(id, '', references.hasEntity, 'lens entity', warnings))
    .filter(Boolean);
  const rawDetail = read('detail');
  const detail = rawDetail && details.has(rawDetail as SemanticDetail)
    ? rawDetail as SemanticDetail
    : defaults.detail;
  if (rawDetail && !details.has(rawDetail as SemanticDetail)) warnings.push(`Unknown semantic detail ${rawDetail}; using the default.`);
  const storyId = read('story');
  const validStoryId = storyId
    ? validatedId(storyId, '', references.hasStory, 'story', warnings)
    : '';

  const state = canonicalNavigationState({
    repositoryId: read('repo') ?? defaults.repositoryId,
    snapshotId,
    viewId,
    rootEntityId,
    selectedId,
    camera: {
      x: parseFinite(read('cx'), defaults.camera.x, 'cx', warnings),
      y: parseFinite(read('cy'), defaults.camera.y, 'cy', warnings),
      zoom: parseFinite(read('z'), defaults.camera.zoom, 'z', warnings),
    },
    ...(detail ? { detail } : {}),
    ...(lensPath.length ? { lensPath } : {}),
    ...(read('filter') ? { filterId: validatedId(read('filter'), defaults.filterId ?? '', undefined, 'filter', warnings) } : {}),
    ...(validStoryId ? {
      story: {
        id: validStoryId,
        step: parseInteger(read('step'), 0, 'step', warnings),
        positionMs: parseInteger(read('t'), 0, 't', warnings),
      },
    } : {}),
  }, defaults);

  for (const key of params.keys()) {
    if (!knownKeys.has(key) && !(options.preserveParams ?? []).includes(key)) {
      warnings.push(`Ignoring unknown navigation parameter ${key}.`);
    }
  }

  return {
    state,
    canonicalUrl: canonicalNavigationUrl(state, url, queryTooLarge ? { ...options, preserveParams: [] } : options),
    warnings: [...new Set(warnings)],
  };
}

export function serializeNavigationState(state: NavigationState) {
  return JSON.stringify({
    version: state.version,
    repositoryId: state.repositoryId,
    snapshotId: state.snapshotId,
    viewId: state.viewId,
    rootEntityId: state.rootEntityId,
    selectedId: state.selectedId,
    camera: state.camera,
    ...(state.detail ? { detail: state.detail } : {}),
    ...(state.lensPath?.length ? { lensPath: state.lensPath } : {}),
    ...(state.filterId ? { filterId: state.filterId } : {}),
    ...(state.story ? { story: state.story } : {}),
  });
}
