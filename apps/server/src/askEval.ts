import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  askAllowedCitationIds,
  askChatCompletionsBody,
  sanitizeAskPackets,
  sanitizeAskRelations,
  type AskPacket,
  type AskRelation,
} from "./ask.js";
import { buildAskIndex, DEFAULT_ASK_BYTE_BUDGET, retrieveAskSections, type AskIndex, type AskSection } from "./askRetrieval.js";

/**
 * CLA-265 Ask eval harness (shared by `askEval.test.ts` and the live runner `askEvalLive.ts`).
 * BEFORE = the pre-CLA-265 request: web `buildAskContext` packets for the selection + the old
 * scope-only prompt. AFTER = whole-atlas retrieval sections + the same packets + the new prompt.
 * Corpus: `fixtures/ask-eval/snapshot.json.gz`, a projected self-scan of THISS/okie.
 */

export interface AskEvalQuestion {
  id: string;
  /** Variants of one question (wordings × starting selections) share a family. */
  family: string;
  /** Written before tuning and never used to tune retrieval; reported separately. */
  heldOut?: boolean;
  /** Which held-out batch: absent = v1 (lexical), "v2-vocabulary-gap" = frozen before retrieval ran on it. */
  heldOutSet?: string;
  question: string;
  selection: { level: string; selectedId: string };
  expectedFiles: string[];
}

export interface AskEvalFixture {
  snapshot: Record<string, unknown> & { entities: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>>; commitSha: string };
  questions: AskEvalQuestion[];
}

export const ASK_EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/ask-eval");

export function loadAskEvalFixture(dir = ASK_EVAL_DIR): AskEvalFixture {
  const questions = JSON.parse(readFileSync(join(dir, "questions.json"), "utf8")) as { questions: AskEvalQuestion[] };
  const snapshot = JSON.parse(gunzipSync(readFileSync(join(dir, "snapshot.json.gz"))).toString("utf8")) as AskEvalFixture["snapshot"];
  return { snapshot, questions: questions.questions };
}

// ---------------------------------------------------------------------------
// BEFORE: a faithful port of web `apps/web/src/ask/askAtlas.ts` `buildAskContext` (+ `toPacket`), fed
// with snapshot entities (a superset of what the scene holds, so BEFORE recall is an upper bound).

const LEGACY_MAX_PACKETS = 32;
const ROOT_KINDS = new Set(["system", "softwareSystem", "person"]);
const INSPECTOR_EMPTY_SUMMARY = "No summary supplied.";

interface LegacyEntity { id: string; parentId?: string; name: string; kind: string; responsibility?: string; source?: string }

function legacyEntities(snapshot: AskEvalFixture["snapshot"]): LegacyEntity[] {
  return snapshot.entities.map(entity => {
    const refs = Array.isArray(entity.sourceRefs) ? entity.sourceRefs as Array<{ path?: string }> : [];
    return {
      id: String(entity.id),
      ...(typeof entity.parentId === "string" ? { parentId: entity.parentId } : {}),
      name: String(entity.name),
      kind: String(entity.kind),
      ...(typeof entity.responsibility === "string" ? { responsibility: entity.responsibility } : {}),
      ...(refs[0]?.path ? { source: refs[0].path } : {}),
    };
  });
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function legacyScopeIds(entities: readonly LegacyEntity[], selectedId: string): string[] {
  const selected = entities.find(entity => entity.id === selectedId);
  if (!selected) return [];
  const ids = [selected.id];
  if (ROOT_KINDS.has(selected.kind)) {
    ids.push(...entities.filter(entity => entity.parentId === selected.id).map(entity => entity.id));
  } else {
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    let current = selected.parentId ? byId.get(selected.parentId) : undefined;
    const visited = new Set([selected.id]);
    while (current && !visited.has(current.id)) {
      if (ROOT_KINDS.has(current.kind)) break;
      ids.push(current.id);
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    const children = new Map<string, string[]>();
    for (const entity of entities) {
      if (!entity.parentId) continue;
      const list = children.get(entity.parentId) ?? [];
      list.push(entity.id);
      children.set(entity.parentId, list);
    }
    const stack = [...(children.get(selected.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      ids.push(id);
      const nested = children.get(id);
      if (nested) stack.push(...nested);
    }
  }
  return uniqueIds(ids).slice(0, LEGACY_MAX_PACKETS);
}

export function legacyAskContext(snapshot: AskEvalFixture["snapshot"], selectedId: string): { packets: AskPacket[]; relations: AskRelation[] } {
  const entities = legacyEntities(snapshot);
  const scopeIds = legacyScopeIds(entities, selectedId);
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const packets: AskPacket[] = [];
  for (const id of scopeIds) {
    const entity = byId.get(id);
    if (!entity) continue;
    const summary = entity.responsibility?.trim();
    packets.push({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      ...(entity.parentId ? { parentId: entity.parentId } : {}),
      ...(summary && summary !== INSPECTOR_EMPTY_SUMMARY ? { summary } : {}),
      ...(entity.source ? { source: entity.source } : {}),
    });
  }
  const allowed = new Set(scopeIds);
  const relations: AskRelation[] = [];
  for (const relation of snapshot.relations) {
    if (relations.length >= 64) break;
    const from = String(relation.from); const to = String(relation.to);
    if (relation.kind === "duplicates" || !allowed.has(from) || !allowed.has(to)) continue;
    relations.push({ id: String(relation.id), from, to, ...(typeof relation.label === "string" ? { label: relation.label } : {}) });
  }
  const sanitized = sanitizeAskPackets(packets);
  return { packets: sanitized, relations: sanitizeAskRelations(relations, new Set(sanitized.map(packet => packet.id))) };
}

/** Verbatim pre-CLA-265 system prompt, kept only so the live eval can replay BEFORE. */
export const LEGACY_ASK_SYSTEM_PROMPT = `You answer questions about a software architecture atlas.
Use ONLY the JSON packets and accepted summaries in the user message.
Do not use other knowledge of the repository. Do not invent files, ids, or scopes.
Do not dump the whole repository. Cite only ids that appear in those packets.
If the question cannot be answered from this scope, say so.
Return JSON: {"answer": string, "citations": string[]}`;

export function legacyAskChatCompletionsBody(modelId: string, question: string, packets: readonly AskPacket[], relations: readonly AskRelation[]): Record<string, unknown> {
  const payload: Record<string, unknown> = { question, allowedCitationIds: packets.map(packet => packet.id), packets };
  if (relations.length > 0) payload.relations = relations;
  return {
    model: modelId,
    max_tokens: 1_024,
    messages: [
      { role: "system", content: LEGACY_ASK_SYSTEM_PROMPT },
      { role: "user", content: `Answer this question using ONLY the packets and accepted summaries below. Cite only allowedCitationIds.\n\n${JSON.stringify(payload, null, 2)}` },
    ],
    response_format: { type: "json_object" },
  };
}

// ---------------------------------------------------------------------------
// AFTER + metrics

export interface AskEvalRun {
  question: AskEvalQuestion;
  before: { packets: AskPacket[]; relations: AskRelation[]; allowedIds: string[]; evidenceFiles: string[]; recall: number; bytes: number };
  after: { sections: AskSection[]; allowedIds: string[]; evidenceFiles: string[]; recall: number; bytes: number };
}

export function evidenceFiles(packets: readonly AskPacket[], sections: readonly AskSection[]): string[] {
  const files = new Set<string>();
  for (const packet of packets) if (packet.source) files.add(packet.source);
  for (const section of sections) if (section.path) files.add(section.path);
  return [...files].sort();
}

export function fileRecall(expected: readonly string[], files: Iterable<string>): number {
  if (expected.length === 0) return 1;
  const have = new Set(files);
  return expected.filter(file => have.has(file)).length / expected.length;
}

export function runAskEvalQuestion(fixture: AskEvalFixture, index: AskIndex, question: AskEvalQuestion, byteBudget = DEFAULT_ASK_BYTE_BUDGET): AskEvalRun {
  const context = legacyAskContext(fixture.snapshot, question.selection.selectedId);
  const beforeFiles = evidenceFiles(context.packets, []);
  const retrieval = retrieveAskSections(index, question.question, { selectedIds: context.packets.map(packet => packet.id), byteBudget });
  const afterFiles = evidenceFiles(context.packets, retrieval.sections);
  return {
    question,
    before: {
      ...context,
      allowedIds: context.packets.map(packet => packet.id),
      evidenceFiles: beforeFiles,
      recall: fileRecall(question.expectedFiles, beforeFiles),
      bytes: Buffer.byteLength(JSON.stringify(context.packets)),
    },
    after: {
      sections: retrieval.sections,
      allowedIds: askAllowedCitationIds(context.packets, retrieval.sections),
      evidenceFiles: afterFiles,
      recall: fileRecall(question.expectedFiles, afterFiles),
      bytes: retrieval.bytes,
    },
  };
}

export function afterAskChatCompletionsBody(modelId: string, index: AskIndex, run: AskEvalRun): Record<string, unknown> {
  return askChatCompletionsBody(modelId, run.question.question, run.before.packets, run.before.relations, {
    mode: "atlas",
    sections: run.after.sections,
    searchedScopes: index.containerNames,
    entityCount: index.documents.length,
  });
}

export function buildAskEvalIndex(fixture: AskEvalFixture): AskIndex {
  return buildAskIndex(fixture.snapshot);
}

/** Files behind cited ids (section path, else the indexed entity's path, else the packet source). */
export function citedFiles(citations: readonly string[], index: AskIndex, packets: readonly AskPacket[] = []): string[] {
  const byPacket = new Map(packets.map(packet => [packet.id, packet]));
  const files = new Set<string>();
  for (const id of citations) {
    const docIndex = index.byId.get(id);
    const path = docIndex !== undefined ? index.documents[docIndex]!.path : byPacket.get(id)?.source;
    if (path) files.add(path);
  }
  return [...files].sort();
}

/**
 * Heuristic: the answer's lead declines ("not in the evidence", "packets do not describe …"). Only the
 * opening is checked, so an answer that notes a missing detail at the end still counts as answered.
 */
export function saysNotInEvidence(answer: string): boolean {
  const lead = answer.trim().slice(0, 240);
  return /not in the (?:evidence|packets|provided|selected)|(?:packets|evidence|scope)[^.]{0,40}(?:contain|include|describe|mention)s? no\b|(?:does|do) not (?:contain|include|describe|mention|cover)|cannot be answered|no (?:information|description) (?:about|of|on)/i.test(lead);
}

/** Stable fingerprint of a gateway request body; replay.json records it so retrieval/prompt drift forces a re-record. */
export function askRequestSha256(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Mean of per-family means, so 21 renderer variants count as one question. */
export function familyMean<T extends { question: AskEvalQuestion }>(rows: readonly T[], value: (row: T) => number): number {
  const families = new Map<string, number[]>();
  for (const row of rows) families.set(row.question.family, [...(families.get(row.question.family) ?? []), value(row)]);
  const means = [...families.values()].map(list => list.reduce((sum, item) => sum + item, 0) / list.length);
  return means.length ? means.reduce((sum, item) => sum + item, 0) / means.length : 0;
}
