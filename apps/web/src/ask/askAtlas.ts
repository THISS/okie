import { inspectorAcceptedSummary, CYCLOMATIC_FLAG_THRESHOLD } from '../inspector/inspectorPanel';

/**
 * Ask Atlas client (CLA-27): bound the live question to packets + accepted
 * summaries for the selected (or isolated) scopes, then POST the same gateway
 * the scan server already uses. No chat history — one question, one answer.
 */

export const MAX_ASK_PACKETS = 32;
export const ASK_PROBE_TIMEOUT_MS = 2_000;
export const ASK_REQUEST_TIMEOUT_MS = 60_000;

export const ASK_NOT_CONNECTED_COPY =
  'Live Q&A is not connected in this renderer slice. Submitting plays the evidence-linked Okie explanation.';
export const ASK_CONNECTED_COPY =
  'Answers cite current packets and accepted summaries for the selected or isolated scopes.';
export const ASK_NOT_CONNECTED_LIVE_MESSAGE =
  'Playing the saved Okie context-to-source explanation. Live repository Q&A is not connected yet.';

const ROOT_KINDS = new Set(['system', 'softwareSystem', 'person']);

export type AskEntity = {
  id: string;
  parentId?: string;
  name: string;
  kind: string;
  responsibility?: string;
  source?: string;
  cyclomaticComplexity?: number;
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

export type AskAnswer =
  | { connected: false }
  | { connected: true; answer: string; citations: string[]; scopeIds: string[] }
  | { connected: true; error: string };

export type AskFetch = typeof fetch;

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
  for (const id of scopeIds) {
    const entity = byId.get(id);
    if (!entity) continue;
    packets.push(toPacket(entity));
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
  } = {},
): Promise<AskAnswer> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ASK_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        question,
        packets: context.packets,
        relations: context.relations,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) return { connected: false };
      return { connected: true, error: `Ask failed (${response.status}).` };
    }
    const body = await response.json() as AskAnswer;
    if (!body || typeof body !== 'object' || (body.connected !== true && body.connected !== false)) {
      return { connected: false };
    }
    if (body.connected === false) return { connected: false };
    if ('error' in body && typeof body.error === 'string' && body.error) {
      return { connected: true, error: body.error };
    }
    if ('answer' in body && typeof body.answer === 'string' && body.answer.trim()) {
      return {
        connected: true,
        answer: body.answer,
        citations: Array.isArray(body.citations) ? body.citations.filter(id => typeof id === 'string') : [],
        scopeIds: Array.isArray(body.scopeIds) ? body.scopeIds.filter(id => typeof id === 'string') : [],
      };
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

function toPacket(entity: AskEntity): AskPacket {
  const summary = inspectorAcceptedSummary(entity);
  const complexity = entity.cyclomaticComplexity;
  const hasCyclomatic = typeof complexity === 'number' && Number.isInteger(complexity) && complexity >= 1;
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
