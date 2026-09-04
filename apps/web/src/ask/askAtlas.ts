import { inspectorAcceptedSummary, CYCLOMATIC_FLAG_THRESHOLD } from '../inspector/inspectorPanel';
import { readDemoQuery } from '../renderer/query';
import { parseAppRoute } from '../renderer/route';

/**
 * Ask Atlas client (CLA-27 + CLA-69): bound the live question to packets +
 * accepted summaries for the selected (or isolated) scopes, then POST the
 * same gateway the scan server already uses. Live POST requires the browsing
 * user's GitHub session. Threads persist per user + owner/repo + commitSha.
 */

export const MAX_ASK_PACKETS = 32;
export const ASK_PROBE_TIMEOUT_MS = 2_000;
export const ASK_REQUEST_TIMEOUT_MS = 60_000;
export const ASK_THREAD_PATH = '/api/ask/thread';
export const ASK_LOGIN_PATH = '/api/auth/github';

export const ASK_NOT_CONNECTED_COPY =
  'Live Q&A is not connected in this renderer slice. Submitting plays the evidence-linked Okie explanation.';
export const ASK_CONNECTED_COPY =
  'Answers cite current packets and accepted summaries for the selected or isolated scopes.';
export const ASK_NOT_CONNECTED_LIVE_MESSAGE =
  'Playing the saved Okie context-to-source explanation. Live repository Q&A is not connected yet.';
export const ASK_SIGNIN_COPY =
  'Sign in with GitHub to ask live questions. Viewing this atlas stays public — there is no login wall on the map.';

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

export type AskScopeIdentity = {
  selectedId: string;
  isolateActive: boolean;
  isolatedIds: readonly string[];
};

export type AskAtlasIdentity = {
  owner: string;
  repo: string;
  commitSha: string;
};

export type AskThreadTurn = {
  id: string;
  question: string;
  answer: string;
  citations: string[];
  scopeIds: string[];
  createdAt: number;
};

export type AskThreadView = {
  owner: string;
  repo: string;
  commitSha: string;
  turns: AskThreadTurn[];
};

export type AskAuthView = {
  authenticated: boolean;
  login?: string;
  loginPath: string;
  logoutPath: string;
  testLoginPath?: string;
};

export type AskAnswer =
  | { connected: false }
  | { connected: true; answer: string; citations: string[]; scopeIds: string[]; thread?: AskThreadView }
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

function sanitizeAtlasPart(value: string): string | undefined {
  const trimmed = value.trim();
  if (!GITHUB_NAME.test(trimmed) || trimmed === '.' || trimmed === '..') return undefined;
  return trimmed;
}

export function sanitizeAskAtlasIdentity(raw: {
  owner: string;
  repo: string;
  commitSha: string;
}): AskAtlasIdentity | undefined {
  const owner = sanitizeAtlasPart(raw.owner);
  const repo = sanitizeAtlasPart(raw.repo);
  const commitSha = raw.commitSha.trim();
  if (!owner || !repo || !COMMIT_SHA.test(commitSha)) return undefined;
  return { owner, repo, commitSha };
}

/**
 * Atlas identity for Ask threads: hosted `/r/owner/repo` plus the loaded
 * snapshot commit, or the local fixture stand-in (scan → THISS/okie).
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
    return sanitizeAskAtlasIdentity({ owner: route.owner, repo: route.repo, commitSha });
  }
  const query = readDemoQuery(input.search ?? '');
  if (query.fixture === 'scan') {
    if (query.scanRepo) {
      const parts = query.scanRepo.split('__');
      if (parts[0] && parts[1]) {
        return sanitizeAskAtlasIdentity({ owner: parts[0], repo: parts.slice(1).join('__'), commitSha });
      }
    }
    return sanitizeAskAtlasIdentity({ owner: 'THISS', repo: 'okie', commitSha });
  }
  if (query.fixture === 'okie') {
    return sanitizeAskAtlasIdentity({ owner: 'okie', repo: 'golden', commitSha });
  }
  return undefined;
}

export function askSignInHref(loginPath: string, returnPath: string): string {
  const path = loginPath || ASK_LOGIN_PATH;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}return=${encodeURIComponent(returnPath)}`;
}

function defaultAskAuth(): AskAuthView {
  return {
    authenticated: false,
    loginPath: ASK_LOGIN_PATH,
    logoutPath: '/api/auth/logout',
  };
}

export async function fetchAskAuth(options: {
  fetch?: AskFetch;
  signal?: AbortSignal;
} = {}): Promise<AskAuthView> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
    if (!response.ok) return defaultAskAuth();
    const body = await response.json() as Partial<AskAuthView>;
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
    if (typeof body.login === 'string' && body.login) view.login = body.login;
    if (typeof body.testLoginPath === 'string' && body.testLoginPath.startsWith('/')) {
      view.testLoginPath = body.testLoginPath;
    }
    return view;
  } catch {
    return defaultAskAuth();
  }
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
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isAskThreadTurn) : [];
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

export function isAskRootKind(kind: string) {
  return ROOT_KINDS.has(kind);
}

/**
 * Stable identity for the packets Ask is allowed to cite. Used so an in-flight
 * or leftover answer cannot land after the user changes selection or Isolate.
 */
export function askScopeKey(options: AskScopeIdentity): string {
  if (options.isolateActive && options.isolatedIds.length > 0) {
    return `isolate:${uniqueIds(options.isolatedIds).slice().sort().join(',')}`;
  }
  return `select:${options.selectedId}`;
}

export function shouldCommitAskAnswer(submittedScopeKey: string, currentScopeKey: string) {
  return submittedScopeKey === currentScopeKey;
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
  } = {},
): Promise<AskSubmitResult> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ASK_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
      return { connected: true, error: `Ask failed (${response.status}).` };
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
      const result: Extract<AskAnswer, { connected: true; answer: string }> = {
        connected: true,
        answer: body.answer,
        citations: Array.isArray(body.citations) ? body.citations.filter(id => typeof id === 'string') : [],
        scopeIds: Array.isArray(body.scopeIds) ? body.scopeIds.filter(id => typeof id === 'string') : [],
      };
      if (body.thread && typeof body.thread === 'object' && Array.isArray(body.thread.turns)) {
        result.thread = {
          owner: typeof body.thread.owner === 'string' ? body.thread.owner : options.atlas?.owner ?? '',
          repo: typeof body.thread.repo === 'string' ? body.thread.repo : options.atlas?.repo ?? '',
          commitSha: typeof body.thread.commitSha === 'string' ? body.thread.commitSha : options.atlas?.commitSha ?? '',
          turns: body.thread.turns.filter(isAskThreadTurn),
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
