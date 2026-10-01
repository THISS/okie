import { inspectorAcceptedSummary, CYCLOMATIC_FLAG_THRESHOLD } from '../inspector/inspectorPanel';
import { DOGFOOD_ATLAS_OWNER, DOGFOOD_ATLAS_REPO } from '../hostedAtlas';
import { readDemoQuery } from '../renderer/query';
import { parseAppRoute } from '../renderer/route';
import { readableAskAnswer } from './answerText';

/**
 * Ask Atlas client (CLA-27 + CLA-69 + CLA-265): send the question with packets
 * for the selected (or isolated) scopes as a starting point plus the atlas
 * slug, so the server can retrieve from the whole atlas and its source. Live
 * POST requires the browsing user's GitHub session. Threads persist per user +
 * owner/repo + commitSha; turns may carry resolved citation details and a
 * retrieval summary (older turns do not).
 */

export const MAX_ASK_PACKETS = 32;
export const ASK_PROBE_TIMEOUT_MS = 2_000;
export const ASK_REQUEST_TIMEOUT_MS = 120_000;
export const ASK_THREAD_PATH = '/api/ask/thread';
export const ASK_LOGIN_PATH = '/api/auth/github';

export const ASK_NOT_CONNECTED_COPY =
  'Live Q&A is not connected. Typed questions are not answered in this renderer slice. Guided tours and the inspector stay available — they are not a live answer.';
export const ASK_CONNECTED_COPY =
  'Answers search the whole atlas and its captured source, and cite the parts they use. Your selection or Isolate set is sent as a starting point.';
export const ASK_NOT_CONNECTED_LIVE_MESSAGE =
  'Live Q&A is not connected. No answer was returned and the overview tour was not started.';
export const ASK_SIGNIN_COPY =
  'Sign in with GitHub to ask live questions. Viewing this atlas stays public — there is no login wall on the map.';
export const ASK_CONNECTED_SUBMIT_LABEL = 'Ask';
export const ASK_DISCONNECTED_SUBMIT_LABEL = 'Not connected';

const ROOT_KINDS = new Set(['system', 'softwareSystem', 'person']);

export type AskEntity = {
  id: string;
  parentId?: string;
  name: string;
  kind: string;
  responsibility?: string;
  source?: string;
  cyclomaticComplexity?: number;
  duplicates?: Array<{ id: string; name: string }>;
  coverageFileHitRate?: number;
  coverageUntestedRanges?: Array<{ startLine: number; endLine: number }>;
  untestedBehaviours?: Array<{ startLine: number; endLine: number; behaviour: string }>;
};

export type AskSceneRelation = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

export type AskPacket = {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  summary?: string;
  source?: string;
  cyclomaticComplexity?: number;
  cyclomaticFlagged?: boolean;
  duplicates?: Array<{ id: string; name: string }>;
  coverageFileHitRate?: number;
  coverageFileHitPercent?: number;
  coverageUntestedRanges?: Array<{ startLine: number; endLine: number }>;
  untestedBehaviours?: Array<{ startLine: number; endLine: number; behaviour: string }>;
};

export type AskRelation = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

export type AskContext = {
  packets: AskPacket[];
  relations: AskRelation[];
};

export type AskScopeOptions = {
  entities: readonly AskEntity[];
  relations?: readonly AskSceneRelation[];
  selectedId: string;
  isolateActive: boolean;
  isolatedIds: readonly string[];
};

export type AskAtlasIdentity = {
  owner: string;
  repo: string;
  commitSha: string;
  /** Published scan slug (`owner__repo`) so the server can retrieve from the whole atlas. */
  slug?: string;
};

/** Resolved citation details (CLA-265). Old turns have none; the UI falls back to scene names. */
export type AskCitationDetail = {
  id: string;
  name: string;
  kind: string;
  path?: string;
  startLine?: number;
  endLine?: number;
};

/** Which scopes the server searched for this answer (CLA-265). */
export type AskRetrieval = {
  mode: 'atlas' | 'scope-only';
  searchedWholeAtlas: boolean;
  selectedScopeIds: string[];
  retrievedScopeIds: string[];
  sectionCount: number;
  bytes: number;
};

export type AskThreadTurn = {
  id: string;
  question: string;
  answer: string;
  citations: string[];
  scopeIds: string[];
  createdAt: number;
  citationDetails?: AskCitationDetail[];
  retrieval?: AskRetrieval;
};

export type AskThreadView = {
  owner: string;
  repo: string;
  commitSha: string;
  turns: AskThreadTurn[];
};

export type AskAuthView = {
  authenticated: boolean;
  /** Stable account identity used to partition browser-local history. */
  accountId?: string;
  login?: string;
  loginPath: string;
  logoutPath: string;
  testLoginPath?: string;
  /** CLA-316 hosted accounts: the edge's `/account` page (email, product updates, delete). Absent on the local server. */
  accountPath?: string;
  /**
   * CLA-266 hosted public mode (`/api/auth/me` answers `mode: "public"`): there is no sign-in route,
   * Ask is open to everyone (the edge Worker rate-limits and budgets it) and account chrome is hidden.
   */
  publicMode?: boolean;
  /**
   * CLA-266 browse-only launch: `/api/auth/me` answers `ask: false` when the deployment has Ask
   * disabled (`ASK_ENABLED` off at the edge). The shell then hides every Ask affordance instead of
   * showing a broken one. Absent (older servers, the local operator server) = Ask available.
   */
  askEnabled?: boolean;
};

export type AskAnswer =
  | { connected: false }
  | {
    connected: true;
    answer: string;
    citations: string[];
    scopeIds: string[];
    citationDetails?: AskCitationDetail[];
    retrieval?: AskRetrieval;
    thread?: AskThreadView;
  }
  | { connected: true; error: string };

export type AskSubmitResult =
  | AskAnswer
  | { unauthorized: true; loginPath: string; testLoginPath?: string };

export type AskFetch = typeof fetch;

export function isAskUnauthorized(
  result: AskSubmitResult,
): result is { unauthorized: true; loginPath: string; testLoginPath?: string } {
  return 'unauthorized' in result && result.unauthorized === true;
}

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[A-Za-z0-9._-]{1,80}$/;
const ATLAS_SLUG = /^[A-Za-z0-9._-]{1,200}$/; // matches the server's slug bound

function sanitizeAtlasPart(value: string): string | undefined {
  const trimmed = value.trim();
  if (!GITHUB_NAME.test(trimmed) || trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

export function sanitizeAskAtlasIdentity(raw: {
  owner: string;
  repo: string;
  commitSha: string;
  slug?: string;
}): AskAtlasIdentity | undefined {
  const owner = sanitizeAtlasPart(raw.owner);
  const repo = sanitizeAtlasPart(raw.repo);
  const commitSha = raw.commitSha.trim();
  if (!owner || !repo || !COMMIT_SHA.test(commitSha)) return undefined;
  const slug = raw.slug?.trim();
  return slug && ATLAS_SLUG.test(slug) && !slug.includes('..') ? { owner, repo, commitSha, slug } : { owner, repo, commitSha };
}

/**
 * Atlas identity for Ask threads: hosted `/r/owner/repo` plus the loaded
 * snapshot commit, or the local fixture stand-in (scan → THISS/okie).
 * `slug` names the published scan the server retrieves from: the hosted
 * route slug, or `?scanRepo=`; a plain scan fixture sends none.
 */
export function resolveAskAtlasIdentity(input: {
  pathname: string;
  search?: string;
  commitSha: string;
}): AskAtlasIdentity | undefined {
  const commitSha = input.commitSha.trim();
  if (!COMMIT_SHA.test(commitSha)) return undefined;
  const route = parseAppRoute(input.pathname);
  if (route.kind === 'repo') {
    return sanitizeAskAtlasIdentity({ owner: route.owner, repo: route.repo, commitSha, slug: route.slug });
  }
  const query = readDemoQuery(input.search ?? '');
  if (query.fixture === 'scan') {
    if (query.scanRepo) {
      const parts = query.scanRepo.split('__');
      if (parts[0] && parts[1]) {
        return sanitizeAskAtlasIdentity({ owner: parts[0], repo: parts.slice(1).join('__'), commitSha, slug: query.scanRepo });
      }
    }
    return sanitizeAskAtlasIdentity({ owner: 'THISS', repo: 'okie', commitSha });
  }
  if (query.fixture === 'okie') {
    return sanitizeAskAtlasIdentity({ owner: 'okie', repo: 'golden', commitSha });
  }
  return undefined;
}

/**
 * Public GitHub URL for the atlas on screen. Hosted `/r/owner/repo` and scan
 * fixtures map to that tree. The golden demo's `okie/golden` stand-in is this
 * product (`THISS/okie`). Stress has no repository identity, so it still links
 * the dogfood source rather than a dead header control.
 */
export function atlasSourceRepositoryUrl(identity: AskAtlasIdentity | undefined): string {
  if (identity && (identity.owner !== 'okie' || identity.repo !== 'golden')) {
    return `https://github.com/${identity.owner}/${identity.repo}`;
  }
  return `https://github.com/${DOGFOOD_ATLAS_OWNER}/${DOGFOOD_ATLAS_REPO}`;
}

/** Two-letter badge for the header account control. Unknown session → "?". */
export function accountInitials(login?: string): string {
  const letters = (login ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
  if (letters.length === 1) return letters.toUpperCase();
  return '?';
}

export function askSignInHref(loginPath: string, returnPath: string): string {
  const path = loginPath || ASK_LOGIN_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}return=${encodeURIComponent(returnPath)}`;
}

/**
 * The view when `/api/auth/me` fails (network error, non-2xx, or a non-JSON body such as an SPA
 * fallback page) and this page has no earlier answer. Fails closed: Ask is hidden rather than offered
 * against an API that did not answer.
 */
function unavailableAskAuth(): AskAuthView {
  return {
    authenticated: false,
    loginPath: ASK_LOGIN_PATH,
    logoutPath: '/api/auth/logout',
    askEnabled: false,
  };
}

/** The last view `/api/auth/me` actually answered in this page: a transient failure never revokes it. */
let lastAnsweredAskAuth: AskAuthView | undefined;

/** Test seam: forget the last answered view. */
export function resetAskAuthMemory(): void {
  lastAnsweredAskAuth = undefined;
}

const ASK_AUTH_RETRY_DELAY_MS = 1500;

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0 || signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function requestAskAuth(fetchImpl: AskFetch, signal: AbortSignal | undefined): Promise<AskAuthView | undefined> {
  try {
    const response = await fetchImpl('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return undefined;
    const body = await response.json() as Partial<AskAuthView> & { mode?: unknown; ask?: unknown };
    if (!body || typeof body !== 'object') return undefined;
    const loginPath = typeof body.loginPath === 'string' && body.loginPath.startsWith('/')
      ? body.loginPath
      : ASK_LOGIN_PATH;
    const logoutPath = typeof body.logoutPath === 'string' && body.logoutPath.startsWith('/')
      ? body.logoutPath
      : '/api/auth/logout';
    const view: AskAuthView = {
      authenticated: body.authenticated === true,
      loginPath,
      logoutPath,
    };
    if (view.authenticated && typeof body.accountId === 'string' && body.accountId) view.accountId = body.accountId;
    if (typeof body.login === 'string' && body.login) view.login = body.login;
    if (typeof body.testLoginPath === 'string' && body.testLoginPath.startsWith('/')) {
      view.testLoginPath = body.testLoginPath;
    }
    if (typeof body.accountPath === 'string' && /^\/(?![/\\])/.test(body.accountPath)) view.accountPath = body.accountPath;
    if (body.mode === 'public') view.publicMode = true;
    if (body.ask === false) view.askEnabled = false;
    return view;
  } catch {
    return undefined;
  }
}

/**
 * `/api/auth/me` as an Ask view. Only a real JSON answer decides (`ask: false` hides Ask). A failed
 * request is retried once after a short pause; if that fails too, the page keeps the last answer it got
 * (so a blip while the panel is open does not tear Ask down), and with none it fails closed.
 */
export async function fetchAskAuth(options: {
  fetch?: AskFetch;
  signal?: AbortSignal;
  /** Pause before the single retry (default 1.5 s; tests pass 0). */
  retryDelayMs?: number;
} = {}): Promise<AskAuthView> {
  const fetchImpl = options.fetch ?? fetch;
  let view = await requestAskAuth(fetchImpl, options.signal);
  if (!view && !options.signal?.aborted) {
    await delay(options.retryDelayMs ?? ASK_AUTH_RETRY_DELAY_MS, options.signal);
    if (!options.signal?.aborted) view = await requestAskAuth(fetchImpl, options.signal);
  }
  if (view) {
    lastAnsweredAskAuth = view;
    return { ...view };
  }
  return lastAnsweredAskAuth ? { ...lastAnsweredAskAuth } : unavailableAskAuth();
}

export async function loadAskThread(
  atlas: AskAtlasIdentity,
  options: {
    fetch?: AskFetch;
    signal?: AbortSignal;
  } = {},
): Promise<AskThreadView | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const params = new URLSearchParams({
    owner: atlas.owner,
    repo: atlas.repo,
    commitSha: atlas.commitSha,
  });
  try {
    const response = await fetchImpl(`${ASK_THREAD_PATH}?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
    if (response.status === 401 || !response.ok) return undefined;
    const body = await response.json() as { thread?: Partial<AskThreadView> };
    const thread = body.thread;
    if (!thread || typeof thread !== 'object') return undefined;
    if (thread.owner !== atlas.owner || thread.repo !== atlas.repo || thread.commitSha !== atlas.commitSha) {
      return { owner: atlas.owner, repo: atlas.repo, commitSha: atlas.commitSha, turns: [] };
    }
    const turns = Array.isArray(thread.turns) ? parseAskThreadTurns(thread.turns) : [];
    return { owner: atlas.owner, repo: atlas.repo, commitSha: atlas.commitSha, turns };
  } catch {
    return undefined;
  }
}

function isAskThreadTurn(value: unknown): value is AskThreadTurn {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string'
    && typeof row.question === 'string'
    && typeof row.answer === 'string'
    && Array.isArray(row.citations)
    && Array.isArray(row.scopeIds)
    && typeof row.createdAt === 'number';
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Defensive parse of server citation details: malformed rows are dropped, never trusted. */
export function parseAskCitationDetails(value: unknown): AskCitationDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AskCitationDetail[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue;
    if (typeof row.name !== 'string' || !row.name.trim()) continue;
    seen.add(row.id);
    const detail: AskCitationDetail = { id: row.id, name: row.name.trim(), kind: typeof row.kind === 'string' ? row.kind : '' };
    if (typeof row.path === 'string' && row.path.trim()) detail.path = row.path.trim();
    const startLine = positiveLine(row.startLine);
    const endLine = positiveLine(row.endLine);
    if (detail.path && startLine) {
      detail.startLine = startLine;
      if (endLine && endLine >= startLine) detail.endLine = endLine;
    }
    out.push(detail);
  }
  return out;
}

/** Defensive parse of the retrieval summary; anything malformed is treated as absent. */
export function parseAskRetrieval(value: unknown): AskRetrieval | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.mode !== 'atlas' && row.mode !== 'scope-only') return undefined;
  const count = (input: unknown) => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.floor(input) : 0;
  return {
    mode: row.mode,
    searchedWholeAtlas: row.searchedWholeAtlas === true,
    selectedScopeIds: stringIds(row.selectedScopeIds),
    retrievedScopeIds: stringIds(row.retrievedScopeIds),
    sectionCount: count(row.sectionCount),
    bytes: count(row.bytes),
  };
}

/** Thread turns from the server; turns written before CLA-265 simply lack details/retrieval. */
export function parseAskThreadTurns(value: readonly unknown[]): AskThreadTurn[] {
  const turns: AskThreadTurn[] = [];
  for (const raw of value) {
    if (!isAskThreadTurn(raw)) continue;
    const row = raw as AskThreadTurn & Record<string, unknown>;
    const turn: AskThreadTurn = {
      id: row.id,
      question: row.question,
      answer: readableAskAnswer(row.answer),
      citations: stringIds(row.citations),
      scopeIds: stringIds(row.scopeIds),
      createdAt: row.createdAt,
    };
    const details = parseAskCitationDetails(row.citationDetails);
    if (details?.length) turn.citationDetails = details;
    const retrieval = parseAskRetrieval(row.retrieval);
    if (retrieval) turn.retrieval = retrieval;
    turns.push(turn);
  }
  return turns;
}

type AskAnswerResult = Extract<AskAnswer, { connected: true; answer: string }>;

/**
 * One thread after an answer lands: the server's persisted thread when it sent
 * one, else the previous turns plus this answer as a local turn. The newest
 * turn carries this response's citation details / retrieval when the server
 * thread omitted them. The answer is never kept anywhere else (no duplicate).
 */
export function appendAskAnswer(
  previous: AskThreadView | undefined,
  input: { question: string; result: AskAnswerResult; atlas?: AskAtlasIdentity; now: number },
): { thread: AskThreadView; latestTurnId: string } {
  const { result } = input;
  // The just-answered turn prefers this response's details when the persisted turn lacks them; a
  // persisted retrieval without selectedScopeIds is overlaid by the response's (fuller) retrieval.
  const enrich = (turn: AskThreadTurn): AskThreadTurn => ({
    ...turn,
    ...(!turn.citationDetails && result.citationDetails?.length ? { citationDetails: result.citationDetails } : {}),
    ...(result.retrieval && (!turn.retrieval || turn.retrieval.selectedScopeIds.length === 0)
      ? { retrieval: turn.retrieval ? { ...turn.retrieval, ...result.retrieval } : result.retrieval }
      : {}),
  });
  if (result.thread && result.thread.turns.length > 0) {
    const turns = result.thread.turns.slice();
    const lastIndex = turns.length - 1;
    turns[lastIndex] = enrich(turns[lastIndex]!);
    return { thread: { ...result.thread, turns }, latestTurnId: turns[lastIndex]!.id };
  }
  const base: AskThreadView = previous ?? {
    owner: input.atlas?.owner ?? '',
    repo: input.atlas?.repo ?? '',
    commitSha: input.atlas?.commitSha ?? '',
    turns: [],
  };
  // Deterministic id (callers compute latestTurnId without the previous thread); replacing a
  // same-id turn means a re-applied update can never duplicate it.
  const id = `local-${input.now}`;
  const turn = enrich({
    id,
    question: input.question,
    answer: result.answer,
    citations: result.citations,
    scopeIds: result.scopeIds,
    createdAt: input.now,
  });
  return { thread: { ...base, turns: [...base.turns.filter(existing => existing.id !== id), turn] }, latestTurnId: id };
}

/**
 * A thread load that resolves after an answer landed must not roll the thread
 * back: keep the current thread when it already holds more turns.
 */
export function keepNewerAskThread(current: AskThreadView | undefined, loaded: AskThreadView | undefined): AskThreadView | undefined {
  if (!current || !loaded) return loaded ?? current;
  if (current.owner !== loaded.owner || current.repo !== loaded.repo || current.commitSha !== loaded.commitSha) return loaded;
  return current.turns.length > loaded.turns.length ? current : loaded;
}

/**
 * Framing edge for the Ask panel: docked beside the map it is a left overlay;
 * as a phone / narrow-stage bottom sheet (wider than half the stage) it is a
 * bottom overlay, so a framed citation lands above it.
 */
export function askPanelOverlayEdge(
  panel: { width: number } | undefined,
  canvas: { width: number },
): 'left' | 'bottom' {
  return panel && panel.width > canvas.width / 2 ? 'bottom' : 'left';
}

/**
 * One citation chip (CLA-265). Citations are grouped by source file: a file
 * chip is labelled with the basename plus `path:lines` (the span of the cited
 * symbols; no lines when the whole file is cited) and lists the cited symbol
 * names. Entities without a file (system / containers) get a name-only chip.
 */
export type AskCitationChip = {
  /** The entity a click selects: the single cited symbol, else the file component. `data-ask-citation`. */
  focusId: string;
  /** Every cited id folded into this chip. */
  ids: string[];
  /** Cited ids present in this atlas (what Show on map isolates). */
  mapIds: string[];
  label: string;
  /** `path:start–end`, `path:start`, or `path`; absent for name-only chips. */
  location?: string;
  /** Cited symbol names inside the file (secondary line / tooltip). */
  symbols: string[];
  /** The focus entity is in this atlas, so the chip can select and frame it. */
  onMap: boolean;
  /** The focus entity has captured source the inspector can open. */
  hasSource: boolean;
};

export type AskCitationEntity = {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  detail?: string;
  sourceRefs?: ReadonlyArray<{ path: string; startLine?: number; endLine?: number }>;
  sourceExcerpts?: ReadonlyArray<{ path: string; startLine: number; endLine: number }>;
};

/** Kinds that are never "a file": their chip stays name-only even when a manifest path is known. */
const NAME_ONLY_KINDS = new Set(['system', 'softwareSystem', 'person', 'container', 'store', 'queue']);

export function askCitationLocation(path: string | undefined, startLine?: number, endLine?: number): string | undefined {
  if (!path) return undefined;
  if (!startLine) return path;
  return endLine && endLine > startLine ? `${path}:${startLine}–${endLine}` : `${path}:${startLine}`;
}

/** Humanise a raw entity id (`container:crates-atlas-wasm` → `crates-atlas-wasm`) when nothing better is known. */
function idLabel(id: string): string {
  const tail = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id;
  return tail || id;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

type ResolvedCitation = {
  id: string;
  name: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  onMap: boolean;
  hasSource: boolean;
  parentId?: string;
};

function resolveCitation(
  id: string,
  detail: AskCitationDetail | undefined,
  lookup: { sceneEntity: (id: string) => AskCitationEntity | undefined; snapshotName?: (id: string) => string | undefined },
): ResolvedCitation {
  const entity = lookup.sceneEntity(id);
  const kind = detail?.kind || entity?.kind || '';
  const name = detail?.name ?? entity?.name ?? lookup.snapshotName?.(id) ?? idLabel(id);
  const resolved: ResolvedCitation = {
    id,
    name,
    onMap: Boolean(entity) || Boolean(lookup.snapshotName?.(id)),
    hasSource: Boolean(entity && entity.detail === 'code' && (entity.sourceExcerpts?.length || entity.sourceRefs?.length)),
    ...(entity?.parentId ? { parentId: entity.parentId } : {}),
  };
  if (NAME_ONLY_KINDS.has(kind) || entity?.detail === 'context' || entity?.detail === 'container') return resolved;
  if (detail?.path) {
    resolved.path = detail.path;
    if (detail.startLine) resolved.startLine = detail.startLine;
    if (detail.endLine) resolved.endLine = detail.endLine;
    return resolved;
  }
  const ref = entity?.sourceExcerpts?.[0] ?? entity?.sourceRefs?.[0];
  if (ref?.path && (entity?.detail === 'component' || entity?.detail === 'code')) {
    resolved.path = ref.path;
    // A component's refs describe its file; only declarations carry a meaningful line span.
    if (entity.detail === 'code' && ref.startLine) {
      resolved.startLine = ref.startLine;
      if (ref.endLine) resolved.endLine = ref.endLine;
    }
  }
  return resolved;
}

/**
 * Chips for a turn's citations, grouped by file (see AskCitationChip). Names
 * come from server details, then the loaded scene, then the snapshot. Order is
 * the order each file / entity was first cited.
 */
export function askCitationChips(
  turn: Pick<AskThreadTurn, 'citations' | 'citationDetails'>,
  lookup: {
    sceneEntity: (id: string) => AskCitationEntity | undefined;
    snapshotName?: (id: string) => string | undefined;
  },
): AskCitationChip[] {
  const details = new Map((turn.citationDetails ?? []).map(detail => [detail.id, detail]));
  const ids = uniqueIds([...turn.citations, ...(turn.citationDetails ?? []).map(detail => detail.id)]);
  const groups = new Map<string, ResolvedCitation[]>();
  for (const id of ids) {
    const citation = resolveCitation(id, details.get(id), lookup);
    const key = citation.path ? `path:${citation.path}` : `id:${id}`;
    const group = groups.get(key) ?? [];
    group.push(citation);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const mapIds = group.filter(citation => citation.onMap).map(citation => citation.id);
    if (!first.path) {
      return { focusId: first.id, ids: [first.id], mapIds, label: first.name, symbols: [], onMap: first.onMap, hasSource: first.hasSource };
    }
    const path = first.path;
    const symbols = group.filter(citation => citation.startLine);
    const wholeFile = group.find(citation => !citation.startLine);
    const parentInMap = symbols[0]?.parentId && lookup.sceneEntity(symbols[0].parentId) ? symbols[0].parentId : undefined;
    const focus = symbols.length === 1 ? symbols[0]! : wholeFile ?? group.find(citation => citation.id === parentInMap) ?? symbols[0]!;
    const focusId = symbols.length !== 1 && !wholeFile && parentInMap ? parentInMap : focus.id;
    const start = symbols.length ? Math.min(...symbols.map(citation => citation.startLine!)) : undefined;
    const end = symbols.length ? Math.max(...symbols.map(citation => citation.endLine ?? citation.startLine!)) : undefined;
    const label = basename(path);
    const names = uniqueIds(symbols.map(citation => citation.name)).filter(name => name !== label && name !== path);
    return {
      focusId,
      ids: group.map(citation => citation.id),
      mapIds,
      label,
      location: askCitationLocation(path, start, end)!,
      symbols: names,
      onMap: focusId === focus.id ? focus.onMap : true,
      hasSource: focusId === focus.id && focus.hasSource,
    };
  });
}

/** Where "Show on map" takes the reader (CLA-265). */
export type AskMapPlan =
  /** Every cited part lives in one container: open it at L3 and isolate the cited files. */
  | { level: 'component'; containerId: string; focusIds: string[] }
  /** Cited parts span containers (or only containers are cited): L2, isolate those containers. */
  | { level: 'container'; focusIds: string[] };

const MAP_CONTAINER_KINDS = new Set(['container', 'dataStore', 'store', 'queue']);
const MAP_ROOT_KINDS = new Set(['softwareSystem', 'system', 'externalSystem', 'person', 'boundary']);

/**
 * Decide the level and cards for "Show on map". Each cited id maps to its
 * file-level ancestor (the outermost component below its container) or, when
 * it has none, to its container. One container holding every cited file → L3
 * inside it with those files; anything spanning containers → L2 with the
 * containers. System-level citations add nothing; unknown ids are skipped.
 */
export function askShowOnMapPlan(
  ids: readonly string[],
  lookup: (id: string) => { kind: string; parentId?: string } | undefined,
): AskMapPlan | undefined {
  const files: Array<{ file: string; container?: string }> = [];
  const containers: string[] = [];
  for (const id of ids) {
    let file: string | undefined;
    let container: string | undefined;
    const seen = new Set<string>();
    for (let current: string | undefined = id; current && !seen.has(current); current = lookup(current)?.parentId) {
      seen.add(current);
      const entity = lookup(current);
      if (!entity || MAP_ROOT_KINDS.has(entity.kind)) break;
      if (MAP_CONTAINER_KINDS.has(entity.kind)) { container = current; break; }
      if (entity.kind === 'component') file = current;
    }
    if (container) containers.push(container);
    if (file) files.push({ file, ...(container ? { container } : {}) });
  }
  const distinctContainers = uniqueIds(containers);
  const distinctFiles = uniqueIds(files.map(entry => entry.file));
  if (distinctContainers.length === 1 && distinctFiles.length > 0) {
    return { level: 'component', containerId: distinctContainers[0]!, focusIds: distinctFiles };
  }
  if (distinctContainers.length > 0) return { level: 'container', focusIds: distinctContainers };
  return distinctFiles.length ? { level: 'component', containerId: '', focusIds: distinctFiles } : undefined;
}

/** Smallest on-screen card height (px) "Show on map" accepts before stepping up a level. */
export const ASK_MAP_MIN_CARD_PX = 40;

type MapBox = { x: number; y: number; width: number; height: number };
type MapCamera = { x: number; y: number; zoom: number };
type MapInsets = { top: number; right: number; bottom: number; left: number };

/** True when every box lands inside the unobstructed canvas (a few px of slack) under `camera`. */
export function askBoxesInView(boxes: readonly MapBox[], camera: MapCamera, viewport: { width: number; height: number }, safe: MapInsets): boolean {
  const toScreen = (x: number, y: number) => ({
    x: viewport.width / 2 + (x - camera.x) * camera.zoom,
    y: viewport.height / 2 + (y - camera.y) * camera.zoom,
  });
  return boxes.every(box => {
    const a = toScreen(box.x, box.y);
    const b = toScreen(box.x + box.width, box.y + box.height);
    return a.x >= safe.left - 4 && a.y >= safe.top - 4
      && b.x <= viewport.width - safe.right + 4 && b.y <= viewport.height - safe.bottom + 4;
  });
}

/**
 * Which cited cards "Show on map" frames at a level whose zoom band is fixed.
 * Starting from the first (most relevant) cited card, add each further card
 * while the band can still frame them all on screen; the rest stay isolated
 * and highlighted just off screen instead of forcing a framing that shows
 * none of them. A lone oversized card is still framed (centred).
 */
export function askFramedCluster<C extends MapCamera>(
  ids: readonly string[],
  boundsOf: (id: string) => MapBox | undefined,
  frame: (ids: readonly string[]) => C | undefined,
  viewport: { width: number; height: number },
  safe: MapInsets,
): { ids: string[]; camera: C | undefined; smallestPx: number } {
  const drawn = ids.filter(id => boundsOf(id));
  if (!drawn.length) return { ids: [], camera: undefined, smallestPx: 0 };
  let chosen = [drawn[0]!];
  let camera = frame(chosen);
  for (const id of drawn.slice(1)) {
    const next = [...chosen, id];
    const candidate = frame(next);
    if (candidate && askBoxesInView(next.map(item => boundsOf(item)!), candidate, viewport, safe)) {
      chosen = next;
      camera = candidate;
    }
  }
  const smallestPx = camera ? Math.min(...chosen.map(id => boundsOf(id)!.height)) * camera.zoom : 0;
  return { ids: chosen, camera, smallestPx };
}

/** "Searched: whole atlas · 12 sections" — which scopes the server used for an answer. */
export function askRetrievalLabel(retrieval: AskRetrieval | undefined): string | undefined {
  if (!retrieval) return undefined;
  const sections = `${retrieval.sectionCount} section${retrieval.sectionCount === 1 ? '' : 's'}`;
  if (retrieval.searchedWholeAtlas || retrieval.mode === 'atlas') return `Searched: whole atlas · ${sections}`;
  const scopes = retrieval.selectedScopeIds.length;
  return `Searched: selected scope only (${scopes} part${scopes === 1 ? '' : 's'}) · ${sections}`;
}

export function isAskRootKind(kind: string) {
  return ROOT_KINDS.has(kind);
}

/**
 * Selected scope, or the isolated set when Isolate is on.
 * Root selection (system/person) takes the entity plus direct children only —
 * never a silent walk of every nested code entity.
 */
export function askScopeEntityIds(options: AskScopeOptions): string[] {
  const cap = MAX_ASK_PACKETS;
  if (options.isolateActive && options.isolatedIds.length > 0) {
    return uniqueIds(options.isolatedIds).slice(0, cap);
  }
  const selected = options.entities.find(entity => entity.id === options.selectedId);
  if (!selected) return [];
  const ids = [selected.id];
  if (isAskRootKind(selected.kind)) {
    ids.push(...directChildIds(options.entities, selected.id));
  } else {
    ids.push(...ancestorIdsUntilRoot(options.entities, selected));
    ids.push(...descendantIds(options.entities, selected.id));
  }
  return uniqueIds(ids).slice(0, cap);
}

export function buildAskContext(options: AskScopeOptions): AskContext {
  const scopeIds = askScopeEntityIds(options);
  const allowed = new Set(scopeIds);
  const byId = new Map(options.entities.map(entity => [entity.id, entity]));
  const packets: AskPacket[] = [];
  const knownIds = new Set(options.entities.map(entity => entity.id));
  for (const id of scopeIds) {
    const entity = byId.get(id);
    if (!entity) continue;
    packets.push(toPacket(entity, knownIds));
  }
  const relations: AskRelation[] = [];
  for (const relation of options.relations ?? []) {
    if (relations.length >= 64) break;
    if (!allowed.has(relation.from) || !allowed.has(relation.to)) continue;
    relations.push({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      ...(relation.label ? { label: relation.label } : {}),
    });
  }
  return { packets, relations };
}

export async function probeAskConnection(options: {
  fetch?: AskFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ASK_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('/api/ask', {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json() as { connected?: unknown };
    return body.connected === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function submitAskQuestion(
  question: string,
  context: AskContext,
  options: {
    fetch?: AskFetch;
    timeoutMs?: number;
    signal?: AbortSignal;
    atlas?: AskAtlasIdentity;
    onWarmingUp?: (warming: boolean) => void;
  } = {},
): Promise<AskSubmitResult> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ASK_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (options.onWarmingUp) {
      const statusController = new AbortController();
      const abortStatus = () => statusController.abort();
      controller.signal.addEventListener('abort', abortStatus, { once: true });
      const statusTimer = setTimeout(abortStatus, ASK_PROBE_TIMEOUT_MS);
      try {
        const status = await fetchImpl('/api/ask', {
          credentials: 'include', headers: { accept: 'application/json' }, signal: statusController.signal,
        });
        if (status.ok) {
          const readiness = await status.json() as { warmingUp?: unknown };
          if (!controller.signal.aborted) options.onWarmingUp(readiness.warmingUp === true);
        }
      } catch { /* Readiness is optional; the authenticated POST remains authoritative. */ }
      finally {
        clearTimeout(statusTimer);
        controller.signal.removeEventListener('abort', abortStatus);
      }
    }
    const response = await fetchImpl('/api/ask', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        question,
        packets: context.packets,
        relations: context.relations,
        ...(options.atlas ? { atlas: options.atlas } : {}),
      }),
      signal: controller.signal,
    });
    if (response.status === 401) {
      const body = await response.json().catch(() => ({})) as {
        auth?: { loginPath?: unknown; testLoginPath?: unknown };
      };
      const loginPath = typeof body.auth?.loginPath === 'string' && body.auth.loginPath.startsWith('/')
        ? body.auth.loginPath
        : ASK_LOGIN_PATH;
      const unauthorized: { unauthorized: true; loginPath: string; testLoginPath?: string } = {
        unauthorized: true,
        loginPath,
      };
      if (typeof body.auth?.testLoginPath === 'string' && body.auth.testLoginPath.startsWith('/')) {
        unauthorized.testLoginPath = body.auth.testLoginPath;
      }
      return unauthorized;
    }
    if (!response.ok) {
      if (response.status === 404) return { connected: false };
      const failure = await response.json().catch(() => ({})) as { error?: unknown };
      return { connected: true, error: typeof failure.error === 'string' && failure.error ? failure.error.slice(0, 500) : `Ask failed (${response.status}).` };
    }
    const body = await response.json() as AskAnswer & { thread?: AskThreadView };
    if (!body || typeof body !== 'object' || (body.connected !== true && body.connected !== false)) {
      return { connected: false };
    }
    if (body.connected === false) return { connected: false };
    if ('error' in body && typeof body.error === 'string' && body.error) {
      return { connected: true, error: body.error };
    }
    if ('answer' in body && typeof body.answer === 'string' && body.answer.trim()) {
      const result: AskAnswerResult = {
        connected: true,
        answer: readableAskAnswer(body.answer),
        citations: stringIds(body.citations),
        scopeIds: stringIds(body.scopeIds),
      };
      const citationDetails = parseAskCitationDetails((body as { citationDetails?: unknown }).citationDetails);
      if (citationDetails?.length) result.citationDetails = citationDetails;
      const retrieval = parseAskRetrieval((body as { retrieval?: unknown }).retrieval);
      if (retrieval) result.retrieval = retrieval;
      if (body.thread && typeof body.thread === 'object' && Array.isArray(body.thread.turns)) {
        result.thread = {
          owner: typeof body.thread.owner === 'string' ? body.thread.owner : options.atlas?.owner ?? '',
          repo: typeof body.thread.repo === 'string' ? body.thread.repo : options.atlas?.repo ?? '',
          commitSha: typeof body.thread.commitSha === 'string' ? body.thread.commitSha : options.atlas?.commitSha ?? '',
          turns: parseAskThreadTurns(body.thread.turns),
        };
      }
      return result;
    }
    return { connected: true, error: 'Ask did not return a usable answer.' };
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return { connected: true, error: 'Ask timed out. Live Q&A did not complete.' };
    }
    return { connected: false };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function toPacket(entity: AskEntity, knownIds: ReadonlySet<string>): AskPacket {
  const summary = inspectorAcceptedSummary(entity);
  const complexity = entity.cyclomaticComplexity;
  const hasCyclomatic = typeof complexity === 'number' && Number.isInteger(complexity) && complexity >= 1;
  const duplicates = (entity.duplicates ?? [])
    .filter(row => knownIds.has(row.id) && row.id !== entity.id)
    .filter(row => typeof row.name === 'string' && row.name.trim())
    .map(row => ({ id: row.id, name: row.name.trim() }));
  const rate = entity.coverageFileHitRate;
  const hasCoverageRate = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1;
  const ranges = (entity.coverageUntestedRanges ?? [])
    .filter(range => Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.startLine >= 1 && range.endLine >= range.startLine)
    .map(range => ({ startLine: range.startLine, endLine: range.endLine }))
    .slice(0, 32);
  const behaviours = (entity.untestedBehaviours ?? [])
    .filter(item => Number.isInteger(item.startLine) && Number.isInteger(item.endLine) && item.startLine >= 1 && item.endLine >= item.startLine && typeof item.behaviour === 'string' && item.behaviour.trim())
    .map(item => ({ startLine: item.startLine, endLine: item.endLine, behaviour: item.behaviour.trim() }))
    .slice(0, 8);
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    ...(entity.parentId ? { parentId: entity.parentId } : {}),
    ...(summary ? { summary } : {}),
    ...(entity.source ? { source: entity.source } : {}),
    ...(hasCyclomatic ? {
      cyclomaticComplexity: complexity,
      cyclomaticFlagged: complexity > CYCLOMATIC_FLAG_THRESHOLD,
    } : {}),
    ...(duplicates.length ? { duplicates } : {}),
    ...(hasCoverageRate ? {
      coverageFileHitRate: rate,
      coverageFileHitPercent: Math.round(rate * 100),
    } : {}),
    ...(ranges.length ? { coverageUntestedRanges: ranges } : {}),
    ...(behaviours.length ? { untestedBehaviours: behaviours } : {}),
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function directChildIds(entities: readonly AskEntity[], parentId: string): string[] {
  return entities.filter(entity => entity.parentId === parentId).map(entity => entity.id);
}

function descendantIds(entities: readonly AskEntity[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const entity of entities) {
    if (!entity.parentId) continue;
    const list = children.get(entity.parentId) ?? [];
    list.push(entity.id);
    children.set(entity.parentId, list);
  }
  const out: string[] = [];
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    const nested = children.get(id);
    if (nested) stack.push(...nested);
  }
  return out;
}

function ancestorIdsUntilRoot(entities: readonly AskEntity[], start: AskEntity): string[] {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const out: string[] = [];
  let current = start.parentId ? byId.get(start.parentId) : undefined;
  const visited = new Set<string>([start.id]);
  while (current && !visited.has(current.id)) {
    if (isAskRootKind(current.kind)) break;
    out.push(current.id);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
