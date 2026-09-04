import { randomBytes } from "node:crypto";
import { scrubGithubTokens } from "@okie/scan";
import { redactGatewayText } from "./llmGateway.js";

/**
 * Per-user Ask threads (CLA-69). Keyed by GitHub userId + atlas identity
 * (`owner/repo` + `commitSha`). In-process like the session store: a page
 * reload restores the browsing user's questions and answers for that map.
 * Never stores the operator gateway key, OAuth tokens, or packets.
 */

export const MAX_ASK_THREAD_TURNS = 50;
export const MAX_ASK_THREADS = 1_024;
export const ASK_THREAD_PATH = "/api/ask/thread";

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[A-Za-z0-9._-]{1,80}$/;

export interface AskAtlasIdentity {
  owner: string;
  repo: string;
  commitSha: string;
}

export interface AskThreadTurn {
  id: string;
  question: string;
  answer: string;
  citations: string[];
  scopeIds: string[];
  createdAt: number;
}

export interface AskThread {
  userId: string;
  owner: string;
  repo: string;
  commitSha: string;
  turns: AskThreadTurn[];
  updatedAt: number;
}

export interface PublicAskThread {
  owner: string;
  repo: string;
  commitSha: string;
  turns: Array<{
    id: string;
    question: string;
    answer: string;
    citations: string[];
    scopeIds: string[];
    createdAt: number;
  }>;
}

export interface AskThreadTurnInput {
  question: string;
  answer: string;
  citations: readonly string[];
  scopeIds: readonly string[];
}

export interface AskThreadStore {
  get(userId: string, atlas: AskAtlasIdentity): AskThread | undefined;
  append(userId: string, atlas: AskAtlasIdentity, turn: AskThreadTurnInput): AskThread;
}

function threadKey(userId: string, atlas: AskAtlasIdentity): string {
  return `${userId}\u0000${atlas.owner}/${atlas.repo}\u0000${atlas.commitSha}`;
}

function trimName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!GITHUB_NAME.test(trimmed) || trimmed === "." || trimmed === "..") return undefined;
  return trimmed;
}

export function sanitizeAskAtlasIdentity(raw: unknown): AskAtlasIdentity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const owner = typeof record.owner === "string" ? trimName(record.owner) : undefined;
  const repo = typeof record.repo === "string" ? trimName(record.repo) : undefined;
  const commitSha = typeof record.commitSha === "string" ? record.commitSha.trim() : "";
  if (!owner || !repo || !COMMIT_SHA.test(commitSha)) return undefined;
  return { owner, repo, commitSha };
}

export function askAtlasIdentityFromSearch(search: URLSearchParams): AskAtlasIdentity | undefined {
  return sanitizeAskAtlasIdentity({
    owner: search.get("owner") ?? "",
    repo: search.get("repo") ?? "",
    commitSha: search.get("commitSha") ?? "",
  });
}

export function publicAskThread(thread: AskThread): PublicAskThread {
  return {
    owner: thread.owner,
    repo: thread.repo,
    commitSha: thread.commitSha,
    turns: thread.turns.map(turn => ({
      id: turn.id,
      question: turn.question,
      answer: turn.answer,
      citations: turn.citations,
      scopeIds: turn.scopeIds,
      createdAt: turn.createdAt,
    })),
  };
}

export function emptyPublicAskThread(atlas: AskAtlasIdentity): PublicAskThread {
  return { owner: atlas.owner, repo: atlas.repo, commitSha: atlas.commitSha, turns: [] };
}

function sanitizeTurnText(text: string, apiKey: string | undefined, maxChars: number): string {
  const scrubbed = scrubGithubTokens(redactGatewayText(text, apiKey)).trim();
  return scrubbed.slice(0, maxChars);
}

function sanitizeIdList(ids: readonly string[], max = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (out.length >= max) break;
    if (typeof id !== "string") continue;
    const trimmed = scrubGithubTokens(id).trim().slice(0, 200);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function createAskThreadStore(now: () => number = () => Date.now()): AskThreadStore {
  const threads = new Map<string, AskThread>();
  return {
    get(userId, atlas) {
      return threads.get(threadKey(userId, atlas));
    },
    append(userId, atlas, turn) {
      const key = threadKey(userId, atlas);
      const existing = threads.get(key);
      const createdAt = now();
      const nextTurn: AskThreadTurn = {
        id: randomBytes(8).toString("hex"),
        question: turn.question,
        answer: turn.answer,
        citations: [...turn.citations],
        scopeIds: [...turn.scopeIds],
        createdAt,
      };
      if (!existing) {
        while (threads.size >= MAX_ASK_THREADS) {
          const oldest = threads.keys().next().value;
          if (oldest === undefined) break;
          threads.delete(oldest);
        }
        const created: AskThread = {
          userId,
          owner: atlas.owner,
          repo: atlas.repo,
          commitSha: atlas.commitSha,
          turns: [nextTurn],
          updatedAt: createdAt,
        };
        threads.set(key, created);
        return created;
      }
      existing.turns.push(nextTurn);
      if (existing.turns.length > MAX_ASK_THREAD_TURNS) {
        existing.turns.splice(0, existing.turns.length - MAX_ASK_THREAD_TURNS);
      }
      existing.updatedAt = createdAt;
      return existing;
    },
  };
}

export function persistAskTurn(
  store: AskThreadStore,
  userId: string,
  atlas: AskAtlasIdentity,
  turn: AskThreadTurnInput,
  apiKey: string | undefined,
): AskThread {
  return store.append(userId, atlas, {
    question: sanitizeTurnText(turn.question, apiKey, 2_000),
    answer: sanitizeTurnText(turn.answer, apiKey, 8_000),
    citations: sanitizeIdList(turn.citations),
    scopeIds: sanitizeIdList(turn.scopeIds),
  });
}
