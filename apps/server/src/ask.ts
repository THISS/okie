import { scrubGithubTokens, CYCLOMATIC_FLAG_THRESHOLD } from "@okie/scan";
import {
  createLlmGatewayClient,
  isUsableModelId,
  redactGatewayText,
  requireUsableModelId,
  type LlmChatCompletionResult,
  type LlmGatewayConfig,
} from "./llmGateway.js";

/**
 * Ask Atlas Q&A (CLA-27): one-shot answers grounded in the client-supplied
 * packets + accepted summaries for the selected (or isolated) scopes.
 * Same OpenAI-compatible gateway as enrichment. Never loads the whole repo.
 */

export const MAX_ASK_PACKETS = 32;
export const MAX_ASK_RELATIONS = 64;
export const MAX_ASK_QUESTION_CHARS = 2_000;
export const ASK_MAX_OUTPUT_TOKENS = 1_024;

export interface AskPacket {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  summary?: string;
  source?: string;
  cyclomaticComplexity?: number;
  cyclomaticFlagged?: boolean;
  duplicates?: Array<{ id: string; name: string }>;
}

export interface AskRelation {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export type AskStatus = { connected: false } | { connected: true };

export type AskAnswer =
  | { connected: false }
  | {
      connected: true;
      answer: string;
      citations: string[];
      scopeIds: string[];
    }
  | {
      connected: true;
      error: string;
    };

export interface AskGateway {
  modelId: string;
  chatCompletions: (body: Record<string, unknown>) => Promise<LlmChatCompletionResult>;
}

const ASK_SYSTEM_PROMPT = `You answer questions about a software architecture atlas.
Use ONLY the JSON packets and accepted summaries in the user message.
Do not use other knowledge of the repository. Do not invent files, ids, or scopes.
Do not dump the whole repository. Cite only ids that appear in those packets.
If the question cannot be answered from this scope, say so.
Return JSON: {"answer": string, "citations": string[]}`;

export function publicAskStatus(config: LlmGatewayConfig): AskStatus {
  return { connected: askGatewayConnected(config) };
}

/** True only when the OpenAI-compatible gateway client can be constructed. */
export function askGatewayConnected(config: LlmGatewayConfig): boolean {
  return Boolean(createLlmGatewayClient(config));
}

export function askChatCompletionsBody(
  modelId: string,
  question: string,
  packets: readonly AskPacket[],
  relations: readonly AskRelation[],
): Record<string, unknown> {
  return {
    model: requireUsableModelId(modelId),
    max_tokens: ASK_MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      { role: "user", content: askUserMessage(question, packets, relations) },
    ],
    response_format: { type: "json_object" },
  };
}

export function askUserMessage(
  question: string,
  packets: readonly AskPacket[],
  relations: readonly AskRelation[],
): string {
  const allowed = packets.map(packet => packet.id);
  const payload: Record<string, unknown> = {
    question,
    allowedCitationIds: allowed,
    packets,
  };
  if (relations.length > 0) payload.relations = relations;
  return `Answer this question using ONLY the packets and accepted summaries below. Cite only allowedCitationIds.\n\n${JSON.stringify(payload, null, 2)}`;
}

export function sanitizeAskPackets(raw: unknown): AskPacket[] {
  if (!Array.isArray(raw)) return [];
  const packets: AskPacket[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (packets.length >= MAX_ASK_PACKETS) break;
    const packet = sanitizePacket(item);
    if (!packet || seen.has(packet.id)) continue;
    seen.add(packet.id);
    packets.push(packet);
  }
  return packets;
}

export function sanitizeAskRelations(raw: unknown, scopeIds: ReadonlySet<string>): AskRelation[] {
  if (!Array.isArray(raw)) return [];
  const relations: AskRelation[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (relations.length >= MAX_ASK_RELATIONS) break;
    const relation = sanitizeRelation(item, scopeIds);
    if (!relation || seen.has(relation.id)) continue;
    seen.add(relation.id);
    relations.push(relation);
  }
  return relations;
}

/**
 * One-shot Ask. No gateway → `{ connected: false }` immediately (no network).
 * Empty scopes never fall back to a whole-repo dump.
 */
export async function answerAskQuestion(
  config: LlmGatewayConfig,
  body: unknown,
  options: { gateway?: AskGateway; timeoutMs?: number } = {},
): Promise<AskAnswer> {
  if (!askGatewayConnected(config)) return { connected: false };

  const client = options.gateway ?? createLlmGatewayClient(
    config,
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
  );
  if (!client) return { connected: false };

  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const question = sanitizeQuestion(record.question);
  if (!question) {
    return { connected: true, error: "Ask needs a question." };
  }

  const packets = sanitizeAskPackets(record.packets);
  if (packets.length === 0) {
    return { connected: true, error: "Ask needs a selected or isolated scope." };
  }
  const scopeIds = new Set(packets.map(packet => packet.id));
  const relations = sanitizeAskRelations(record.relations, scopeIds);
  const modelId = options.gateway?.modelId ?? config.modelId;
  if (!isUsableModelId(modelId)) {
    return { connected: true, error: "Ask is connected but the model id is empty." };
  }

  try {
    const result = await client.chatCompletions(
      askChatCompletionsBody(modelId, question, packets, relations),
    );
    const parsed = parseAskCompletion(result.json, scopeIds);
    if (!parsed) {
      return { connected: true, error: "Ask did not return a usable answer." };
    }
    return {
      connected: true,
      answer: parsed.answer,
      citations: parsed.citations,
      scopeIds: packets.map(packet => packet.id),
    };
  } catch (error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    return { connected: true, error: redactGatewayText(raw, config.apiKey) };
  }
}

function sanitizeQuestion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = scrubGithubTokens(raw).trim();
  if (!text) return undefined;
  return text.slice(0, MAX_ASK_QUESTION_CHARS);
}

function sanitizePacket(raw: unknown): AskPacket | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = optionalTrimmedString(record.id);
  const name = optionalTrimmedString(record.name);
  const kind = optionalTrimmedString(record.kind);
  if (!id || !name || !kind) return undefined;
  const packet: AskPacket = {
    id: scrubGithubTokens(id),
    name: scrubGithubTokens(name).slice(0, 200),
    kind: scrubGithubTokens(kind).slice(0, 64),
  };
  const parentId = optionalTrimmedString(record.parentId);
  if (parentId) packet.parentId = scrubGithubTokens(parentId);
  const summary = optionalTrimmedString(record.summary);
  if (summary) packet.summary = scrubGithubTokens(summary).slice(0, 800);
  const source = optionalTrimmedString(record.source);
  if (source) packet.source = scrubGithubTokens(source).slice(0, 400);
  if (typeof record.cyclomaticComplexity === "number"
    && Number.isInteger(record.cyclomaticComplexity)
    && record.cyclomaticComplexity >= 1) {
    packet.cyclomaticComplexity = record.cyclomaticComplexity;
    packet.cyclomaticFlagged = record.cyclomaticComplexity > CYCLOMATIC_FLAG_THRESHOLD;
  }
  if (Array.isArray(record.duplicates)) {
    const duplicates: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    for (const row of record.duplicates) {
      if (duplicates.length >= 16) break;
      if (!row || typeof row !== "object") continue;
      const counterpart = row as Record<string, unknown>;
      const counterpartId = optionalTrimmedString(counterpart.id);
      const counterpartName = optionalTrimmedString(counterpart.name);
      if (!counterpartId || !counterpartName || seen.has(counterpartId) || counterpartId === packet.id) continue;
      seen.add(counterpartId);
      duplicates.push({
        id: scrubGithubTokens(counterpartId),
        name: scrubGithubTokens(counterpartName).slice(0, 200),
      });
    }
    if (duplicates.length) packet.duplicates = duplicates;
  }
  return packet;
}

function sanitizeRelation(raw: unknown, scopeIds: ReadonlySet<string>): AskRelation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = optionalTrimmedString(record.id);
  const from = optionalTrimmedString(record.from);
  const to = optionalTrimmedString(record.to);
  if (!id || !from || !to) return undefined;
  if (!scopeIds.has(from) || !scopeIds.has(to)) return undefined;
  const relation: AskRelation = { id: scrubGithubTokens(id), from, to };
  const label = optionalTrimmedString(record.label);
  if (label) relation.label = scrubGithubTokens(label).slice(0, 200);
  return relation;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    }).join("");
  }
  return undefined;
}

function unwrapJsonPayload(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

export function parseAskCompletion(
  json: unknown,
  scopeIds: ReadonlySet<string>,
): { answer: string; citations: string[] } | undefined {
  const record = typeof json === "object" && json !== null ? json as Record<string, unknown> : undefined;
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = choices[0];
  const message = first && typeof first === "object" && first !== null
    ? (first as Record<string, unknown>).message
    : undefined;
  const content = message && typeof message === "object" && message !== null
    ? (message as Record<string, unknown>).content
    : undefined;
  const text = textFromContent(content)?.trim();
  if (!text) return undefined;

  let answer = text;
  let citations: string[] = [];
  try {
    const parsed = JSON.parse(unwrapJsonPayload(text)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const body = parsed as Record<string, unknown>;
      if (typeof body.answer === "string" && body.answer.trim()) {
        answer = body.answer.trim();
      }
      if (Array.isArray(body.citations)) {
        citations = body.citations.filter((id): id is string => typeof id === "string");
      }
    }
  } catch {
    // Prose fallback: keep the raw text and pick citations from ids that appear in it.
  }

  const allowed = [...scopeIds];
  const cited = citations
    .map(id => id.trim())
    .filter(id => scopeIds.has(id));
  const unique = [...new Set(cited.length > 0 ? cited : allowed.filter(id => answer.includes(id)))];
  if (!answer) return undefined;
  return { answer, citations: unique };
}
