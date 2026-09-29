import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanArtifacts } from "@okie/scan";
import { askChatCompletionsBody, askAllowedCitationIds, citationsNamedInAnswer, parseAskCompletion, type AskPacket, type AskRelation } from "./ask.js";
import { askRequestSha256, legacyAskContext, saysNotInEvidence, type AskEvalFixture } from "./askEval.js";
import { DEFAULT_ASK_BYTE_BUDGET, retrieveAskSections, type AskIndex, type AskSection } from "./askRetrieval.js";
import { JEV_INPUT_USD_PER_TOKEN } from "./claimCheckEvaluation.js";
import { CLAIM_CHECK_FILE, isClaimCheckAttempt, runClaimChecks, type ClaimCheckLimits } from "./claimChecks.js";
import type { OperatorBudgetLedger } from "./operatorBudget.js";
import type { OperatorEnrichmentGateway } from "./operatorEnrichment.js";
import type { JudgmentProvider } from "./operatorJudgments.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";
import { classifyLlmGatewayFailure, type GatewayUsage, type LlmGatewayConfig } from "./llmGateway.js";
import type { LlmRateLimiter } from "./llmRateLimiter.js";

/**
 * CLA-289 cross-repo evaluation core, shared by `scripts/cross-repo-eval.mjs` (the one command that
 * fetches, scans, enriches, checks claims, asks and captures blocks) and `crossRepoEval.test.ts`
 * (offline replay: recomputes `metrics.json` from committed labels + recorded runs).
 *
 * Nothing here changes product defaults: retrieval variants only pass options into
 * `retrieveAskSections`, and enrichment / claim checks run the real operator pipeline with injected
 * seams (local scan, gateway, ledgers).
 */

export const CROSS_REPO_EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/cross-repo-eval");
/** Live spend cap for the WHOLE ticket (Ask + enrichment + Jev). `--max-dollars` may only lower it. */
export const TICKET_CAP_USD = 3;
export const RUN_SCHEMA = "cross-repo-eval-run/v1";
export const METRICS_SCHEMA = "cross-repo-eval-metrics/v1";
export const SPEND_SCHEMA = "cross-repo-eval-spend/v1";
/** Ranked retrieved paths kept per question (the product packs at most MAX_ASK_SECTIONS = 40 sections). */
export const RECORDED_RANKED_PATHS = 40;
export const RECALL_KS = [5, 10] as const;
export { DEFAULT_ASK_BYTE_BUDGET };
/**
 * Pricing used only for live-spend reservations and estimates when the gateway reports no cost:
 * fitted to the usage + cost rows in fixtures/ask-eval/replay.json (xiaomi/mimo-v2.6-pro via
 * OpenRouter: ~$0.36 / 1M input, ~$1.67 / 1M output), rounded up.
 */
export const GATEWAY_INPUT_USD_PER_TOKEN = 0.4 / 1_000_000;
export const GATEWAY_OUTPUT_USD_PER_TOKEN = 1.7 / 1_000_000;
/** Gateway price per token (input / output). */
export interface GatewayPrice { input: number; output: number }
/**
 * Models whose worst-case pricing is known. Every constant above was fitted to ONE model; a live run with
 * any other `modelId` is refused unless `--price-per-mtok in/out` supplies its price.
 */
export const KNOWN_GATEWAY_PRICES: Readonly<Record<string, GatewayPrice>> = {
  "xiaomi/mimo-v2.6-pro": { input: GATEWAY_INPUT_USD_PER_TOKEN, output: GATEWAY_OUTPUT_USD_PER_TOKEN },
};
export const DEFAULT_GATEWAY_PRICE: GatewayPrice = { input: GATEWAY_INPUT_USD_PER_TOKEN, output: GATEWAY_OUTPUT_USD_PER_TOKEN };
/** Worst case for one enrichment request at the known model's price ($0.015), scaled for other prices. */
export function perRequestWorstUsd(price: GatewayPrice = DEFAULT_GATEWAY_PRICE): number {
  return 0.015 * Math.max(1, price.input / GATEWAY_INPUT_USD_PER_TOKEN, price.output / GATEWAY_OUTPUT_USD_PER_TOKEN);
}
/** The price to reserve/estimate with, or an error when the model is unknown and no override was given. */
export function resolveGatewayPrice(modelId: string, overridePerMTok?: { input: number; output: number }): GatewayPrice {
  if (overridePerMTok) {
    if (!(overridePerMTok.input > 0) || !(overridePerMTok.output > 0)) throw new Error("--price-per-mtok needs two positive numbers: in/out");
    return { input: overridePerMTok.input / 1_000_000, output: overridePerMTok.output / 1_000_000 };
  }
  const known = KNOWN_GATEWAY_PRICES[modelId];
  if (!known) throw new Error(`refusing --live: no known pricing for model ${modelId} (known: ${Object.keys(KNOWN_GATEWAY_PRICES).join(", ")}); pass --price-per-mtok <in>/<out> (USD per 1M tokens)`);
  return known;
}
/** Jev bills input tokens only (jev-1.13.0, 2026-09-19); it reports no cost. Re-exported from the product's claim-check evaluation. */
export { JEV_INPUT_USD_PER_TOKEN };
/**
 * What the product ledger reserves per Jev request (operatorJudgments REQUEST_DOLLARS, not exported):
 * the "product-reservation-equivalent" cost reported beside the token estimate.
 */
export const JEV_RESERVATION_USD_PER_REQUEST = 0.003;

// ---------------------------------------------------------------------------
// Manifest + labels

export interface EvalPrepare { dropSymlinks?: boolean; dropPaths?: string[]; why?: string }
export interface ManifestRepo {
  slug: string; repository: string; url: string; commitSha: string; license?: string; shape?: string; language?: string; notes?: string;
  size?: { trackedFiles?: number; checkoutMB?: number };
  evalPrepare?: EvalPrepare;
}
export interface CrossRepoManifest { schema: string; repos: ManifestRepo[] }

export interface LabelQuestion {
  id: string; family: string; status?: string; category?: string; question: string;
  selection: { level: string; selectedId: string };
  expectedFiles: string[];
  mustMention: string[];
  answerNote?: string;
}
export interface LabelOverview { nodeId: string; status?: string; order: string[]; note?: string }
export interface CrossRepoLabels {
  schema: string; repository: string; commitSha: string; status?: string;
  questions: LabelQuestion[];
  c4Note?: { verdict?: string; note?: string; expectedContainers?: string[]; problems?: string[] };
  overviews?: LabelOverview[];
}

export function loadManifest(dir = CROSS_REPO_EVAL_DIR): CrossRepoManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as CrossRepoManifest;
}

function readJsonDir<T>(dir: string): Map<string, T> {
  const out = new Map<string, T>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter(name => name.endsWith(".json")).sort()) out.set(file.slice(0, -5), JSON.parse(readFileSync(join(dir, file), "utf8")) as T);
  return out;
}
export const loadLabels = (dir = CROSS_REPO_EVAL_DIR): Map<string, CrossRepoLabels> => readJsonDir<CrossRepoLabels>(join(dir, "labels"));
export const loadRuns = (dir = CROSS_REPO_EVAL_DIR): Map<string, CrossRepoRun> => readJsonDir<CrossRepoRun>(join(dir, "runs"));

/** Local checkout directory name. The scanner derives system/container ids from it, and the labels were drafted against `<owner>_<repo>` scans. */
export function checkoutName(repo: Pick<ManifestRepo, "repository">): string {
  return repo.repository.replace("/", "_");
}

// ---------------------------------------------------------------------------
// Recorded runs (fixtures/cross-repo-eval/runs/<slug>.json)

export interface RepoSignals {
  entities: number; containers: number; components: number; files: number;
  /** Directory depth of component source files (segments before the file name). */
  maxDepth: number; medianDepth: number;
  language?: string;
}
export interface ScanOutcome {
  revision: string; ok: boolean; ms: number;
  error?: string;
  /** Scan-level limitations (skipped symlinks/submodules, excluded test data) — CLA-299. */
  limitations?: string[];
  entities?: number; relations?: number;
  kinds?: Record<string, number>;
  containers?: Array<{ id: string; name: string; components: number }>;
  signals?: RepoSignals;
}
export interface RecordedSection { id: string; kind: string; p?: number; symbols?: Array<{ id: string; name: string }> }
export interface RecordedAnswer {
  modelId: string;
  /** sha256 of the exact request body (without the live-only `usage` flag). */
  requestSha256: string;
  allowedIdsCount: number;
  allowedIdsSha256: string;
  /** Allowed ids that occur in the completion text: parsing against these equals parsing against all allowed ids. */
  allowedIdsInContent: string[];
  /** Selected-scope packet id -> path index, for packets named in the completion. */
  packetSources: Record<string, number>;
  content: string;
  usage?: GatewayUsage;
  ms: number;
}
export interface RecordedRetrieval { byteBudget: number; bytes: number; sectionCount: number; ranked: number[] }
export interface RecordedQuestion extends RecordedRetrieval {
  id: string; question: string; selectedId: string;
  /** False when the label's starting selection is not in the atlas (packets are then empty). */
  selectionFound: boolean;
  /** Selected-scope packet source paths (legacy web context), path indexes. */
  packets: number[];
  /** Retrieved sections, kept only when an answer is recorded (the replay parser needs them; retrieval metrics use `ranked`). */
  sections?: RecordedSection[];
  /** Whether each expected file (at record time) is present in the atlas at all (scanner blindness vs ranking). */
  expectedIndexed: Record<string, boolean>;
  variants: Record<string, RecordedRetrieval>;
  answer?: RecordedAnswer;
}
/** Which harness produced a record: `git rev-parse HEAD` + whether tracked harness files differed from it. */
export interface Provenance { harnessSha: string; harnessDirty: boolean }
/** Why an enrichment scope failed: the product's stored attempt error (redacted, clipped) + a coarse class. */
export interface ScopeFailure { scopeId: string; kind?: string; class: FailureClass; error: string }
export type FailureClass = "timeout" | "rate-limit" | "server" | "http" | "transport" | "invalid-output" | "rejected-by-validator" | "other";

/** Coarse class of a stored attempt error, so a timeout reads differently from a model/validator rejection. */
export function classifyFailure(error: string): FailureClass {
  const kind = classifyLlmGatewayFailure(new Error(error));
  if (kind === "timeout") return "timeout";
  if (kind === "rate_limit") return "rate-limit";
  if (kind === "server" || kind === "http" || kind === "transport") return kind;
  // Product message prefixes first (paths/ids inside the message must not decide the class).
  if (/^(?:malformed|rejected) explanation\b/i.test(error)) return "rejected-by-validator";
  if (/^llm gateway response (?:content )?is not JSON\b|^llm gateway response is not valid|^unparseable\b/i.test(error)) return "invalid-output";
  if (/^[^:]*\b(?:timed? ?out|aborted)\b/i.test(error)) return "timeout";
  return "other";
}

/** What the enrichment pass covered: the whole scan, or a sampled subtree (see `sampleComponents`). */
export type EnrichmentScope =
  | { mode: "full" }
  | {
    mode: "sampled";
    /** Components kept per container (`singleContainerK` when the atlas has one container). */
    k: number; singleContainerK?: number;
    componentsSampled: number; componentsFull: number; containers: number;
    /** Source files of unsampled components dropped in the local sampled commit. */
    droppedFiles: number; sampledCommitSha: string;
    /** Container/system summaries were written from the sampled children only. */
    parentsFromSample: true;
    /** Accepted explanations are overlaid onto the full-scan snapshot for Ask/blocks. */
    overlaidOnFullScan: true;
  };
export interface EnrichmentRecord {
  provenance?: Provenance;
  scope?: EnrichmentScope;
  mode: "live" | "fake";
  modelId?: string;
  depth: string;
  caps: { maxRequests: number; maxTokens: number; maxDollars: number; maxConcurrent: number; globalMaxDollars?: number };
  ms: number; runState: string; stopped?: string; error?: string; ledger?: string;
  requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEstimated: boolean;
  coverage: { accepted: number; failed: number; notRun: number; belowCap: number; inScope: number };
  byKind: Record<string, { total: number; accepted: number; failed: number; notRun: number; belowCap: number }>;
  systemExplained: boolean;
  containersExplained: number;
  /** Accepted parents (system/container/component with in-cap children) whose in-cap children were not all settled — impossible under the "not run" policy, recorded to prove it. */
  parentsWithUnsettledChildren: number;
  /** Live 429s seen below the rate limiter (each was backed off and retried by it). */
  rateLimited?: number;
  /** Every failed scope with the product's stored error (why it failed). */
  failures?: ScopeFailure[];
}
export interface ClaimRecord {
  provenance?: Provenance;
  mode: "live" | "fake";
  modelId?: string;
  caps?: { maxRequests: number; maxTokens: number; maxDollars: number; maxConcurrent: number; timeoutMs: number };
  ms: number; outcome: string; stopped?: string; requests: number;
  inputTokens: number;
  /** Booked spend: measured cost, else input tokens x the Jev rate (`costEstimated: true`). */
  costUsd: number; costEstimated: boolean;
  /** What the product ledger would have reserved for these requests ($0.003 each). */
  reservationEquivalentUsd?: number;
  rateLimited?: number;
  /**
   * `reason` = the product's reason (code rows: missing-capture | truncated-capture | oversized-evidence or a
   * failed-check reason; unavailable rows: timeout | invalid-response | provider-failure | budget);
   * `kind` = the C4 kind of the explained scope.
   */
  rows: ClaimRow[];
}
export interface ClaimRow { scopeId: string; claimId: string; state: string; source: string; reason?: string; kind?: string; confidence?: number }
export interface RecordedBlockNode {
  nodeId: string; name: string; kind: string;
  candidates: Array<{ id: string; type: string; preview: string }>;
  /** What the Overview renders today (default recipe, cut to the plan budget). */
  defaultOrder: string[];
  jev?: { order?: string[]; omitted?: Array<{ id: string; why: string }>; unavailable?: string; inputTokens?: number; estimatedCostUsd?: number; latencyMs?: number };
}
export interface CrossRepoRun {
  schema: typeof RUN_SCHEMA;
  slug: string; repository: string; commitSha: string;
  preparedCommitSha?: string;
  evalPrepare?: EvalPrepare & { droppedPaths?: number };
  /** Paid stages still recorded over a retired evalPrepare commit (CLA-299). */
  paidStagesCorpus?: { preparedCommitSha: string; evalPrepare?: EvalPrepare & { droppedPaths?: number }; stages: string[]; note: string };
  scan?: { provenance?: Provenance; asIs: ScanOutcome; prepared?: ScanOutcome };
  enrichment?: EnrichmentRecord;
  /** Enrichment deliberately not run (e.g. the scanner cannot see the repo's language). */
  enrichmentSkipped?: { reason: string };
  claims?: ClaimRecord;
  ask?: { provenance?: Provenance; modelId?: string; caps?: { maxConcurrent: number; byteBudget: number }; recordedAt: string; corpus: AskCorpus; entityCount: number; systemNames: string[]; paths: string[]; rateLimited?: number; questions: RecordedQuestion[] };
  blocks?: { provenance?: Provenance; jevModelId?: string; caps?: { maxDollars: number; requests: number }; corpus: AskCorpus; nodes: RecordedBlockNode[] };
  /** Wall-clock ms of the last pass of each stage (fetch/scan/enrich/claims/ask/blocks). */
  stageMs?: Partial<Record<StageName, number>>;
}
/** Which snapshot Ask/blocks ran over: the deterministic scan, a fully enriched export, or a sampled enrichment overlaid onto the full scan. */
export type AskCorpus = "scan" | "enriched" | "sampled-enriched";
export const STAGE_NAMES = ["fetch", "scan", "enrich", "claims", "ask", "blocks"] as const;
export type StageName = typeof STAGE_NAMES[number];

export function emptyRun(repo: ManifestRepo): CrossRepoRun {
  return { schema: RUN_SCHEMA, slug: repo.slug, repository: repo.repository, commitSha: repo.commitSha };
}

// ---------------------------------------------------------------------------
// Scan summaries + repo signals

interface SnapshotLike { entities: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>>; commitSha?: string }

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function repoSignals(snapshot: SnapshotLike, language?: string): RepoSignals {
  const kinds = new Map<string, number>();
  const files = new Set<string>();
  const depths: number[] = [];
  for (const entity of snapshot.entities) {
    const kind = String(entity.kind);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const refs = Array.isArray(entity.sourceRefs) ? entity.sourceRefs as Array<{ path?: unknown }> : [];
    for (const ref of refs) if (typeof ref.path === "string") files.add(ref.path);
    if (kind === "component") for (const ref of refs) if (typeof ref.path === "string") depths.push(ref.path.split("/").length - 1);
  }
  return {
    entities: snapshot.entities.length, containers: kinds.get("container") ?? 0, components: kinds.get("component") ?? 0, files: files.size,
    maxDepth: depths.length ? Math.max(...depths) : 0, medianDepth: median(depths),
    ...(language ? { language } : {}),
  };
}

export function scanOutcome(revision: string, ms: number, snapshot: SnapshotLike, language?: string): ScanOutcome {
  const kinds: Record<string, number> = {};
  for (const entity of snapshot.entities) kinds[String(entity.kind)] = (kinds[String(entity.kind)] ?? 0) + 1;
  const containers = snapshot.entities.filter(entity => entity.kind === "container").map(entity => ({
    id: String(entity.id), name: String(entity.name),
    components: snapshot.entities.filter(child => child.parentId === entity.id && child.kind === "component").length,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { revision, ok: true, ms, entities: snapshot.entities.length, relations: snapshot.relations.length, kinds, containers, signals: repoSignals(snapshot, language) };
}

// ---------------------------------------------------------------------------
// Retrieval (free) + Ask request bodies

/** Budget variants keyed on repo signals. Predefined before any label was scored; product defaults are untouched. */
export interface RetrievalVariant { name: string; description: string; byteBudget(signals: RepoSignals): number }
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export const RETRIEVAL_VARIANTS: readonly RetrievalVariant[] = [
  { name: "default", description: "product default (24 KB)", byteBudget: () => DEFAULT_ASK_BYTE_BUDGET },
  { name: "half", description: "12 KB for every repo (cheaper prompts)", byteBudget: () => DEFAULT_ASK_BYTE_BUDGET / 2 },
  { name: "double", description: "48 KB for every repo", byteBudget: () => DEFAULT_ASK_BYTE_BUDGET * 2 },
  { name: "size-scaled", description: "24 KB x clamp(sqrt(entities / 1000), 0.5, 3)", byteBudget: signals => Math.round(DEFAULT_ASK_BYTE_BUDGET * clamp(Math.sqrt(signals.entities / 1000), 0.5, 3)) },
  { name: "depth-scaled", description: "24 KB x clamp(1 + (median component depth - 2) / 4, 1, 2): deep paths spend bytes on names", byteBudget: signals => Math.round(DEFAULT_ASK_BYTE_BUDGET * clamp(1 + (signals.medianDepth - 2) / 4, 1, 2)) },
];

export interface AskQuestionContext {
  packets: AskPacket[]; relations: AskRelation[]; sections: AskSection[]; bytes: number; allowedIds: string[]; selectionFound: boolean;
}

/** The AFTER request exactly as `runAskEvalQuestion` builds it, plus the product's `systemNames: [repo]` (scanServer passes the atlas repo name). */
export function askQuestionContext(snapshot: AskEvalFixture["snapshot"], index: AskIndex, question: Pick<LabelQuestion, "question" | "selection">, options: { byteBudget?: number; systemNames?: readonly string[] } = {}): AskQuestionContext {
  const context = legacyAskContext(snapshot, question.selection.selectedId);
  const retrieval = retrieveAskSections(index, question.question, { selectedIds: context.packets.map(packet => packet.id), byteBudget: options.byteBudget ?? DEFAULT_ASK_BYTE_BUDGET, ...(options.systemNames ? { systemNames: options.systemNames } : {}) });
  return { ...context, sections: retrieval.sections, bytes: retrieval.bytes, allowedIds: askAllowedCitationIds(context.packets, retrieval.sections), selectionFound: index.byId.has(question.selection.selectedId) };
}

export function askBody(modelId: string, index: AskIndex, question: string, context: AskQuestionContext): Record<string, unknown> {
  return askChatCompletionsBody(modelId, question, context.packets, context.relations, { mode: "atlas", sections: context.sections, searchedScopes: index.containerNames, entityCount: index.documents.length });
}

/** Path table shared by one run's recorded questions (keeps runs small). */
export class PathTable {
  readonly paths: string[];
  readonly #index = new Map<string, number>();
  constructor(initial: readonly string[] = []) { this.paths = [...initial]; this.paths.forEach((path, index) => this.#index.set(path, index)); }
  id(path: string): number { let at = this.#index.get(path); if (at === undefined) { at = this.paths.length; this.paths.push(path); this.#index.set(path, at); } return at; }
}

/** First-occurrence order of section paths (the rank used for recall@k). */
export function rankedSectionPaths(sections: readonly Pick<AskSection, "path">[]): string[] {
  const out: string[] = [];
  for (const section of sections) if (section.path && !out.includes(section.path)) out.push(section.path);
  return out;
}

export function recordRetrieval(context: AskQuestionContext, byteBudget: number, table: PathTable): RecordedRetrieval {
  return { byteBudget, bytes: context.bytes, sectionCount: context.sections.length, ranked: rankedSectionPaths(context.sections).slice(0, RECORDED_RANKED_PATHS).map(path => table.id(path)) };
}

export function recordQuestion(snapshot: AskEvalFixture["snapshot"], index: AskIndex, question: LabelQuestion, signals: RepoSignals, table: PathTable, systemNames: readonly string[]): { recorded: RecordedQuestion; context: AskQuestionContext } {
  const context = askQuestionContext(snapshot, index, question, { systemNames });
  const indexed = new Set(index.documents.map(doc => doc.path).filter((path): path is string => Boolean(path)));
  const variants: Record<string, RecordedRetrieval> = {};
  for (const variant of RETRIEVAL_VARIANTS) {
    if (variant.name === "default") continue;
    const byteBudget = variant.byteBudget(signals);
    variants[variant.name] = recordRetrieval(byteBudget === DEFAULT_ASK_BYTE_BUDGET ? context : askQuestionContext(snapshot, index, question, { byteBudget, systemNames }), byteBudget, table);
  }
  const recorded: RecordedQuestion = {
    id: question.id, question: question.question, selectedId: question.selection.selectedId, selectionFound: context.selectionFound,
    ...recordRetrieval(context, DEFAULT_ASK_BYTE_BUDGET, table),
    packets: [...new Set(context.packets.map(packet => packet.source).filter((path): path is string => Boolean(path)))].map(path => table.id(path)),
    sections: context.sections.map(section => ({ id: section.id, kind: section.kind, ...(section.path ? { p: table.id(section.path) } : {}), ...(section.symbols?.length ? { symbols: section.symbols.map(symbol => ({ id: symbol.id, name: symbol.name })) } : {}) })),
    expectedIndexed: Object.fromEntries(question.expectedFiles.map(path => [path, indexed.has(path)])),
    variants,
  };
  return { recorded, context };
}

export function recordAnswer(input: { modelId: string; body: Record<string, unknown>; context: AskQuestionContext; content: string; usage?: GatewayUsage; ms: number; table: PathTable }): RecordedAnswer {
  const { context, content } = input;
  const packetSources: Record<string, number> = {};
  for (const packet of context.packets) if (packet.source && content.includes(packet.id)) packetSources[packet.id] = input.table.id(packet.source);
  return {
    modelId: input.modelId,
    requestSha256: askRequestSha256(input.body),
    allowedIdsCount: context.allowedIds.length,
    allowedIdsSha256: createHash("sha256").update(JSON.stringify(context.allowedIds)).digest("hex"),
    allowedIdsInContent: context.allowedIds.filter(id => content.includes(id)),
    packetSources,
    content,
    ...(input.usage ? { usage: input.usage } : {}),
    ms: input.ms,
  };
}

// ---------------------------------------------------------------------------
// Metric functions

const round = (value: number) => Math.round(value * 1e4) / 1e4;
const mean = (values: readonly number[]): number | null => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Share of expected files among the first k ranked paths (k omitted = all). Empty expectation counts as 1. */
export function recallAtK(expected: readonly string[], ranked: readonly string[], k = Number.POSITIVE_INFINITY): number {
  if (!expected.length) return 1;
  const top = new Set(ranked.slice(0, k));
  return expected.filter(path => top.has(path)).length / expected.length;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Case-insensitive match of one `mustMention` alternative. Alternatives of 3 characters or fewer, and
 * alternatives with no letters, must stand alone (not inside a longer run of letters/digits): otherwise
 * "0", "," or "Arc" would match inside "10", any list or "search". Longer alternatives are plain
 * substrings, so "migrate" still matches "migrated". Terms are literal text, never patterns.
 */
export function mentionAlternativeMatches(answer: string, alternative: string): boolean {
  const part = alternative.trim().toLowerCase();
  if (!part) return false;
  const text = answer.toLowerCase();
  if (part.length > 3 && /\p{L}/u.test(part)) return text.includes(part);
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(part)}(?![\\p{L}\\p{N}_])`, "u").test(text);
}
/** `a|b` accepts either alternative (see `mentionAlternativeMatches`). */
export function mentionMatches(answer: string, term: string): boolean {
  return term.split("|").some(part => mentionAlternativeMatches(answer, part));
}
export function mustMentionAll(answer: string, terms: readonly string[]): boolean {
  return terms.every(term => mentionMatches(answer, term));
}

/**
 * Kendall tau between two orders of the SAME items (ties impossible): (concordant − discordant) / pairs.
 * null for fewer than two items.
 */
export function kendallTau(reference: readonly string[], candidate: readonly string[]): number | null {
  const n = reference.length;
  if (n < 2 || candidate.length !== n) return null;
  const position = new Map(candidate.map((id, index) => [id, index]));
  if (reference.some(id => !position.has(id))) return null;
  let score = 0;
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) score += Math.sign(position.get(reference[j]!)! - position.get(reference[i]!)!);
  return score / (n * (n - 1) / 2);
}

/** Top-k set overlap as a share of min(k, n). */
export function topKAgreement(reference: readonly string[], candidate: readonly string[], k: number): number | null {
  const size = Math.min(k, reference.length, candidate.length);
  if (size === 0) return null;
  const top = new Set(reference.slice(0, size));
  return candidate.slice(0, size).filter(id => top.has(id)).length / size;
}

/**
 * Hand order vs another order. tau/top1/top3 are restricted to their shared candidates (hand order
 * first); `top1Unrestricted` compares the real first block (other[0]) with the hand order's first block.
 */
export function orderAgreement(hand: readonly string[], other: readonly string[]): { shared: number; tau: number | null; top1: number | null; top3: number | null; top1Unrestricted: number | null } | null {
  const otherSet = new Set(other);
  const shared = [...new Set(hand)].filter(id => otherSet.has(id));
  const top1Unrestricted = hand.length && other.length ? (hand[0] === other[0] ? 1 : 0) : null;
  if (!shared.length) return top1Unrestricted === null ? null : { shared: 0, tau: null, top1: null, top3: null, top1Unrestricted };
  const sharedSet = new Set(shared);
  const restricted = [...new Set(other)].filter(id => sharedSet.has(id));
  return { shared: shared.length, tau: kendallTau(shared, restricted), top1: topKAgreement(shared, restricted, 1), top3: topKAgreement(shared, restricted, 3), top1Unrestricted };
}

/** Hand-ordered block ids that were candidates but are not rendered (blocks the order drops that the labeler kept). */
export function keptButDropped(hand: readonly string[], rendered: readonly string[], candidates: readonly string[]): number {
  const shown = new Set(rendered); const offered = new Set(candidates);
  return [...new Set(hand)].filter(id => offered.has(id) && !shown.has(id)).length;
}

/** Rendered block ids the labeler left out of the hand order (blocks a hand-ordered Overview would drop). */
export function omittedButRendered(hand: readonly string[], rendered: readonly string[]): number {
  const kept = new Set(hand);
  return [...new Set(rendered)].filter(id => !kept.has(id)).length;
}

/** Replays a recorded completion through the product parser + citation completion. */
export function scoreRecordedAnswer(recorded: RecordedQuestion, paths: readonly string[], expected: readonly string[], mustMention: readonly string[]) {
  const answer = recorded.answer;
  if (!answer) return undefined;
  const sections: AskSection[] = (recorded.sections ?? []).map(section => ({ id: section.id, name: "", kind: section.kind, score: 0, ...(section.p !== undefined ? { path: paths[section.p]! } : {}), ...(section.symbols ? { symbols: section.symbols } : {}) }));
  const parsed = parseAskCompletion({ choices: [{ message: { content: answer.content } }] }, new Set(answer.allowedIdsInContent));
  const citations = parsed ? citationsNamedInAnswer(parsed.answer, parsed.citations, sections) : [];
  const pathOf = new Map<string, string>();
  for (const section of sections) if (section.path) { pathOf.set(section.id, section.path); for (const symbol of section.symbols ?? []) pathOf.set(symbol.id, section.path); }
  for (const [id, index] of Object.entries(answer.packetSources)) if (!pathOf.has(id)) pathOf.set(id, paths[index]!);
  const cited = [...new Set(citations.map(id => pathOf.get(id)).filter((path): path is string => Boolean(path)))].sort();
  // An unparseable completion is "invalid", not a decline.
  const invalid = !parsed;
  const declined = parsed ? saysNotInEvidence(parsed.answer) : false;
  const expectedSet = new Set(expected);
  return {
    parsed: Boolean(parsed),
    invalid,
    cited,
    citedRecall: recallAtK(expected, cited),
    citationPrecision: cited.length ? cited.filter(path => expectedSet.has(path)).length / cited.length : null,
    declined,
    mentions: parsed ? mustMention.filter(term => mentionMatches(parsed.answer, term)).length : 0,
    correct: Boolean(parsed) && !declined && mustMentionAll(parsed!.answer, mustMention),
  };
}

export const INSUFFICIENT_STATES = ["insufficient-context", "insufficient"] as const;
/**
 * `insufficient-context` = code found no usable capture (never reached Jev); `insufficient` = Jev judged
 * the excerpts insufficient. Rates are over `judged` = checked − `unavailable` (no verdict was possible:
 * budget/provider), which is reported on its own as `unavailableRate` (over all checked rows).
 */
export function claimRates(rows: ReadonlyArray<{ state: string; reason?: string }>) {
  const byState: Record<string, number> = {};
  for (const row of rows) byState[row.state] = (byState[row.state] ?? 0) + 1;
  // Per-reason counts; rows recorded before reasons were kept count as "unrecorded".
  const reasons = (state: string) => {
    const out: Record<string, number> = {};
    for (const row of rows) if (row.state === state) out[row.reason ?? "unrecorded"] = (out[row.reason ?? "unrecorded"] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const unavailable = byState.unavailable ?? 0;
  const judged = rows.length - unavailable;
  const rate = (count: number) => judged ? count / judged : null;
  return {
    checked: rows.length, judged, byState,
    insufficientContextByReason: reasons("insufficient-context"),
    unavailableByReason: reasons("unavailable"),
    failedCheckByReason: reasons("failed-check"),
    unavailableRate: rows.length ? unavailable / rows.length : null,
    insufficientContextRate: rate(byState["insufficient-context"] ?? 0),
    insufficientRate: rate(byState.insufficient ?? 0),
    notEnoughEvidenceRate: rate((byState["insufficient-context"] ?? 0) + (byState.insufficient ?? 0)),
    supportedRate: rate(byState.supported ?? 0),
  };
}

/** Mean of per-family means (families keyed by repo so equal family names in two repos stay separate). */
export function familyMeanOf<T>(rows: ReadonlyArray<{ key: string; value: T }>, pick: (value: T) => number | null): number | null {
  const families = new Map<string, number[]>();
  for (const row of rows) { const value = pick(row.value); if (value === null) continue; families.set(row.key, [...(families.get(row.key) ?? []), value]); }
  return mean([...families.values()].map(list => mean(list)!));
}

// ---------------------------------------------------------------------------
// Spend ledger (fixtures/cross-repo-eval/spend.json)

export interface SpendEntry { at: string; stage: "enrich" | "claims" | "ask" | "blocks"; slug?: string; usd: number; estimated: boolean; requests: number; note?: string }
export interface SpendLedger { schema: typeof SPEND_SCHEMA; capUsd: number; entries: SpendEntry[] }

export function emptySpendLedger(): SpendLedger { return { schema: SPEND_SCHEMA, capUsd: TICKET_CAP_USD, entries: [] }; }
export function spentUsd(ledger: SpendLedger): number { return ledger.entries.reduce((sum, entry) => sum + entry.usd, 0); }
/** The effective cap: `--max-dollars` (default the ticket cap) may lower but never raise $3. */
export function effectiveCapUsd(maxDollars?: number): number {
  if (maxDollars === undefined) return TICKET_CAP_USD;
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) throw new Error("--max-dollars must be a positive number");
  if (maxDollars > TICKET_CAP_USD) throw new Error(`--max-dollars ${maxDollars} exceeds the ticket cap of $${TICKET_CAP_USD}`);
  return maxDollars;
}
/** Refuses a live request/stage when recorded spend + this reservation would exceed the cap. */
export function admitSpend(ledger: SpendLedger, reservationUsd: number, maxDollars?: number): { ok: true; spent: number; cap: number; remaining: number } | { ok: false; spent: number; cap: number; remaining: number; reason: string } {
  const cap = Math.min(effectiveCapUsd(maxDollars), ledger.capUsd);
  const spent = spentUsd(ledger);
  const remaining = Math.max(0, cap - spent);
  if (!(reservationUsd >= 0)) throw new Error("invalid reservation");
  if (spent + reservationUsd > cap) return { ok: false, spent, cap, remaining, reason: `spent $${spent.toFixed(4)} + reservation $${reservationUsd.toFixed(4)} exceeds the $${cap} cap` };
  return { ok: true, spent, cap, remaining };
}
export function appendSpend(ledger: SpendLedger, entry: SpendEntry): SpendLedger {
  if (!(entry.usd >= 0)) throw new Error("invalid spend");
  return { ...ledger, entries: [...ledger.entries, entry] };
}
/** Worst case for one Ask/enrichment request: input bytes / 3 tokens + all output tokens. */
export function worstCaseRequestUsd(body: Record<string, unknown>, price: GatewayPrice = DEFAULT_GATEWAY_PRICE): number {
  const maxOutput = typeof body.max_tokens === "number" ? body.max_tokens : 4096;
  return Buffer.byteLength(JSON.stringify(body)) / 3 * price.input + maxOutput * price.output;
}
export function usageUsd(usage: GatewayUsage | undefined, price: GatewayPrice = DEFAULT_GATEWAY_PRICE): { usd: number; estimated: boolean } {
  if (usage?.costUsd !== undefined) return { usd: usage.costUsd, estimated: false };
  const input = usage?.promptTokens ?? Math.max(0, (usage?.totalTokens ?? 0) - (usage?.completionTokens ?? 0));
  return { usd: input * price.input + (usage?.completionTokens ?? 0) * price.output, estimated: true };
}

// ---------------------------------------------------------------------------
// Enrichment + claim checks through the real operator pipeline

export interface CrossRepoEnrichmentOptions {
  /** OperatorStore root (scratch, one per repo). */
  root: string;
  source: { owner: string; repo: string; slug: string };
  commitSha: string;
  artifacts: ScanArtifacts;
  mode: "live" | "fake";
  gateway?: OperatorEnrichmentGateway;
  gatewayConfig?: LlmGatewayConfig;
  globalLedger?: OperatorBudgetLedger;
  rateLimiter?: LlmRateLimiter;
  caps: EnrichmentRecord["caps"];
  depth: string;
  scope?: EnrichmentScope;
  provenance?: Provenance;
  price?: GatewayPrice;
}

interface SidecarScope { scopeId: string; parentScopeId?: string; kind: string; state?: string }

/** Coverage by C4 kind + whether any accepted parent had an unsettled (not run) in-cap child. */
export function enrichmentCoverage(sidecar: { scopes: SidecarScope[] }) {
  const byKind: EnrichmentRecord["byKind"] = {};
  for (const scope of sidecar.scopes) {
    const row = byKind[scope.kind] ??= { total: 0, accepted: 0, failed: 0, notRun: 0, belowCap: 0 };
    row.total += 1;
    if (scope.state === "accepted") row.accepted += 1; else if (scope.state === "failed") row.failed += 1; else if (scope.state === "below cap") row.belowCap += 1; else row.notRun += 1;
  }
  const childStates = new Map<string, string[]>();
  for (const scope of sidecar.scopes) if (scope.parentScopeId && scope.state !== "below cap") childStates.set(scope.parentScopeId, [...(childStates.get(scope.parentScopeId) ?? []), scope.state ?? "not run"]);
  const parentsWithUnsettledChildren = sidecar.scopes.filter(scope => scope.state === "accepted" && (childStates.get(scope.scopeId) ?? []).some(state => state === "not run")).length;
  return {
    byKind,
    systemExplained: sidecar.scopes.some(scope => scope.kind === "softwareSystem" && scope.state === "accepted"),
    containersExplained: sidecar.scopes.filter(scope => scope.kind === "container" && scope.state === "accepted").length,
    parentsWithUnsettledChildren,
  };
}

/** Failed scopes (latest attempt per scope) with the stored error, clipped; callers redact before committing. */
export function scopeFailures(attempts: ReadonlyArray<{ scopeId: string; state: string; error?: unknown; updatedAt?: number | string; createdAt?: number | string }>, kinds: ReadonlyMap<string, string>): ScopeFailure[] {
  const latest = new Map<string, (typeof attempts)[number]>();
  const at = (value: number | string | undefined) => typeof value === "number" ? value : value ? Date.parse(value) || 0 : 0;
  for (const attempt of attempts) {
    const prior = latest.get(attempt.scopeId);
    if (!prior || at(attempt.updatedAt ?? attempt.createdAt) >= at(prior.updatedAt ?? prior.createdAt)) latest.set(attempt.scopeId, attempt);
  }
  return [...latest.values()].filter(attempt => attempt.state === "failed").map(attempt => {
    const error = String(attempt.error ?? "unknown").slice(0, 200);
    const kind = kinds.get(attempt.scopeId);
    return { scopeId: attempt.scopeId, ...(kind ? { kind } : {}), class: classifyFailure(error), error };
  }).sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

/** Failed scopes of a recorded enrichment run, read back from its operator store (offline). */
export function enrichmentFailuresFromStore(root: string, runId: string): ScopeFailure[] {
  const store = new OperatorStore(root);
  const state = store.snapshot();
  const drafts = new Set(state.drafts.filter(draft => draft.runId === runId).map(draft => draft.draftRevisionId));
  const attempts = state.attempts.filter(attempt => drafts.has(attempt.draftRevisionId) && !isClaimCheckAttempt(attempt));
  const current = state.drafts.find(draft => draft.draftRevisionId === state.runs.find(run => run.runId === runId)?.draftRevisionId);
  const sidecarText = current ? store.readArtifactFile(current.artifactRevisionId, "operator-explanations.json")?.toString("utf8") : undefined;
  const sidecar = sidecarText ? JSON.parse(sidecarText) as { scopes: SidecarScope[] } : { scopes: [] };
  return scopeFailures(attempts, new Map(sidecar.scopes.map(scope => [scope.scopeId, scope.kind])));
}

/**
 * Claim rows from the claim-check file installed on the run's current draft (the product's own record),
 * with the product `reason` and the explained scope's C4 kind. Offline: no provider is called.
 */
export function claimRowsFromStore(root: string, runId: string): ClaimRow[] {
  const store = new OperatorStore(root);
  const state = store.snapshot();
  const draft = state.drafts.find(value => value.draftRevisionId === state.runs.find(run => run.runId === runId)?.draftRevisionId);
  const sidecarText = draft ? store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")?.toString("utf8") : undefined;
  const kinds = new Map((sidecarText ? (JSON.parse(sidecarText) as { scopes: SidecarScope[] }).scopes : []).map(scope => [scope.scopeId, scope.kind]));
  const file = installedClaimCheckFile(root, runId) as { rows?: Array<{ scopeId: string; claimId: string; state: string; source: string; reason?: string; judgment?: { confidence?: number } }> } | undefined;
  return (file?.rows ?? []).map(row => {
    const kind = kinds.get(row.scopeId);
    return { scopeId: row.scopeId, claimId: row.claimId, state: row.state, source: row.source, ...(row.reason ? { reason: row.reason } : {}), ...(kind ? { kind } : {}), ...(typeof row.judgment?.confidence === "number" ? { confidence: row.judgment.confidence } : {}) };
  });
}

/** A GitHub client that only answers the runner's "is it public" probe (the manifest repos are public). */
const publicRepoClient = () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never;

export async function runCrossRepoEnrichment(options: CrossRepoEnrichmentOptions): Promise<{ runId: string; draftRevisionId?: string; snapshot?: string; sidecar?: string; record: EnrichmentRecord }> {
  const store = new OperatorStore(options.root);
  const publication = new OperatorPublicationService(store);
  const { owner, repo, slug } = options.source;
  const run = store.createRun({ idempotencyKey: `cla289-${slug}-${Date.now()}`, source: { repositoryId: `repo:${owner}/${repo}`, owner, repo, slug, commitSha: options.commitSha } }).run;
  const runner = createOperatorRunner({
    store, publication, githubClient: publicRepoClient, judgmentProvider: null,
    scan: async () => ({ commitSha: options.commitSha, artifacts: options.artifacts }),
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(options.gatewayConfig ? { gatewayConfig: options.gatewayConfig } : {}),
    ...(options.globalLedger ? { globalLedger: options.globalLedger } : {}),
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });
  const started = performance.now();
  await runner.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "unauthenticated" } });
  const ms = Math.round(performance.now() - started);
  const state = store.snapshot();
  const current = state.runs.find(value => value.runId === run.runId)!;
  const drafts = new Set(state.drafts.filter(draft => draft.runId === run.runId).map(draft => draft.draftRevisionId));
  const attempts = state.attempts.filter(attempt => drafts.has(attempt.draftRevisionId) && !isClaimCheckAttempt(attempt));
  const finished = [...state.events].reverse().find(event => event.runId === run.runId && event.type === "enrichment.finished");
  const budget = [...state.events].reverse().find(event => event.runId === run.runId && event.type === "enrichment.budget_reached");
  const draft = state.drafts.find(value => value.draftRevisionId === current.draftRevisionId);
  const sidecarText = draft ? store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")?.toString("utf8") : undefined;
  const snapshotText = draft ? store.readArtifactFile(draft.artifactRevisionId, "snapshot.json")?.toString("utf8") : undefined;
  const sidecar = sidecarText ? JSON.parse(sidecarText) as { scopes: SidecarScope[] } : { scopes: [] };
  const coverage = enrichmentCoverage(sidecar);
  let costUsd = 0; let costEstimated = false; let inputTokens = 0; let outputTokens = 0;
  for (const attempt of attempts) {
    const usage = attempt.usage;
    inputTokens += usage?.inputTokens ?? 0; outputTokens += usage?.outputTokens ?? 0;
    if (usage?.measuredCostUsd !== undefined) costUsd += usage.measuredCostUsd;
    else if (usage) { const price = options.price ?? DEFAULT_GATEWAY_PRICE; costEstimated = true; costUsd += usage.estimatedCostUsd ?? (usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output; }
  }
  const kinds = new Map(sidecar.scopes.map(scope => [scope.scopeId, scope.kind]));
  const failures = scopeFailures(attempts, kinds);
  const detail = finished?.detail ?? {};
  const num = (value: unknown) => typeof value === "number" ? value : 0;
  const record: EnrichmentRecord = {
    ...(options.provenance ? { provenance: options.provenance } : {}),
    scope: options.scope ?? { mode: "full" },
    mode: options.mode,
    ...(attempts[0]?.modelId ? { modelId: attempts[0].modelId } : {}),
    depth: options.depth, caps: options.caps, ms, runState: current.state,
    ...(typeof detail.stopped === "string" ? { stopped: detail.stopped } : {}),
    ...(current.error ? { error: String(current.error).slice(0, 300) } : {}),
    ...(typeof budget?.detail?.ledger === "string" ? { ledger: budget.detail.ledger } : {}),
    requests: attempts.length, inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6, costEstimated,
    coverage: { accepted: num(detail.accepted), failed: num(detail.failed), notRun: num(detail.notRun), belowCap: num(detail.belowCap), inScope: num(detail.inScope) },
    ...coverage,
    ...(failures.length ? { failures } : {}),
  };
  return { runId: run.runId, ...(current.draftRevisionId ? { draftRevisionId: current.draftRevisionId } : {}), ...(snapshotText ? { snapshot: snapshotText } : {}), ...(sidecarText ? { sidecar: sidecarText } : {}), record };
}

/** CLA-145 claim checks over the enriched draft (the pipeline the runner's `claim-checks` job calls). */
export async function runCrossRepoClaimChecks(options: { root: string; runId: string; mode: "live" | "fake"; provider?: JudgmentProvider; limits: ClaimCheckLimits; globalLedger?: OperatorBudgetLedger; provenance?: Provenance }): Promise<ClaimRecord> {
  const store = new OperatorStore(options.root);
  const publication = new OperatorPublicationService(store);
  const run = store.snapshot().runs.find(value => value.runId === options.runId);
  if (!run?.draftRevisionId) throw new Error("claim checks need an enriched draft");
  const before = new Set(store.snapshot().events.map(event => event.eventId));
  const started = performance.now();
  const outcome = await runClaimChecks({ store, publication, runId: run.runId, draftRevisionId: run.draftRevisionId, ...(options.provider ? { provider: options.provider } : {}), limits: options.limits, ...(options.globalLedger ? { globalLedger: options.globalLedger } : {}), enabled: true });
  const ms = Math.round(performance.now() - started);
  // Jev usage is settled on the run's claim-check budget events (not on the attempt rows).
  const settled = store.snapshot().events.filter(event => !before.has(event.eventId) && event.runId === run.runId && event.type === "budget.settled" && event.detail?.kind === "claim-check").map(event => event.detail!);
  const inputTokens = settled.reduce((sum, detail) => sum + (typeof detail.inputTokens === "number" ? detail.inputTokens : 0), 0);
  const measured = settled.filter(detail => typeof detail.measuredCostUsd === "number");
  const allMeasured = settled.length > 0 && measured.length === settled.length;
  const costUsd = allMeasured ? measured.reduce((sum, detail) => sum + Number(detail.measuredCostUsd), 0) : inputTokens * JEV_INPUT_USD_PER_TOKEN;
  // The pass installs its rows on the draft; read them back with reasons + scope kinds.
  const rows = outcome.state === "accepted" ? claimRowsFromStore(options.root, run.runId) : [];
  return {
    ...(options.provenance ? { provenance: options.provenance } : {}),
    mode: options.mode,
    caps: { maxRequests: options.limits.maxRequests, maxTokens: options.limits.maxTokens, maxDollars: options.limits.maxDollars, maxConcurrent: options.limits.maxConcurrent, timeoutMs: options.limits.timeoutMs }, ...(options.provider ? { modelId: options.provider.modelId } : {}), ms, outcome: outcome.state,
    ...(outcome.state === "accepted" && outcome.stopped ? { stopped: outcome.stopped } : {}),
    requests: outcome.state === "accepted" ? outcome.requests : 0,
    inputTokens, costUsd: Math.round(costUsd * 1e7) / 1e7, costEstimated: !allMeasured,
    reservationEquivalentUsd: Math.round((outcome.state === "accepted" ? outcome.requests : 0) * JEV_RESERVATION_USD_PER_REQUEST * 1e7) / 1e7,
    rows,
  };
}

/** Reads the claim-check document installed on the run's current draft (if any). */
export function installedClaimCheckFile(root: string, runId: string): unknown {
  const store = new OperatorStore(root);
  const state = store.snapshot();
  const draft = state.drafts.find(value => value.draftRevisionId === state.runs.find(run => run.runId === runId)?.draftRevisionId);
  const bytes = draft ? store.readArtifactFile(draft.artifactRevisionId, CLAIM_CHECK_FILE) : undefined;
  return bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
}

// ---------------------------------------------------------------------------
// Sampled enrichment: a bounded subtree whose parents still reduce

/**
 * Keeps the top-K components of every container by relation degree (relations touching the component
 * itself; ties by id), and returns the source files of every other component to drop in a local
 * sampled commit. Files any kept non-code entity also cites are never dropped. Deterministic.
 */
export function sampleComponents(snapshot: SnapshotLike, k: number, singleContainerK = k): { keep: string[]; dropPaths: string[]; componentsSampled: number; componentsFull: number; containers: number; perContainer: number } {
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(singleContainerK) || singleContainerK < 1) throw new Error("sample size must be a positive integer");
  const degree = new Map<string, number>();
  for (const relation of snapshot.relations) for (const end of [relation.from, relation.to]) if (typeof end === "string") degree.set(end, (degree.get(end) ?? 0) + 1);
  const containers = snapshot.entities.filter(entity => entity.kind === "container").map(entity => String(entity.id)).sort();
  const perContainer = containers.length === 1 ? singleContainerK : k;
  const components = snapshot.entities.filter(entity => entity.kind === "component");
  const keep = new Set<string>();
  for (const container of containers) {
    components.filter(entity => entity.parentId === container)
      .sort((a, b) => (degree.get(String(b.id)) ?? 0) - (degree.get(String(a.id)) ?? 0) || String(a.id).localeCompare(String(b.id)))
      .slice(0, perContainer).forEach(entity => keep.add(String(entity.id)));
  }
  // Components outside any container are kept (nothing to sample them against).
  for (const entity of components) if (!containers.includes(String(entity.parentId))) keep.add(String(entity.id));
  const paths = (entity: Record<string, unknown>) => (Array.isArray(entity.sourceRefs) ? entity.sourceRefs as Array<{ path?: unknown }> : []).map(ref => ref.path).filter((path): path is string => typeof path === "string");
  const protectedPaths = new Set(snapshot.entities.filter(entity => entity.kind !== "code" && (entity.kind !== "component" || keep.has(String(entity.id)))).flatMap(paths));
  const drop = new Set<string>();
  for (const entity of components) if (!keep.has(String(entity.id))) for (const path of paths(entity)) if (!protectedPaths.has(path)) drop.add(path);
  return { keep: [...keep].sort(), dropPaths: [...drop].sort(), componentsSampled: keep.size, componentsFull: components.length, containers: containers.length, perContainer };
}

// ---------------------------------------------------------------------------
// Blocks: labeler sheet helpers

/** Deterministic shuffle: sort by sha256(seed + id). */
export function shuffledIds(ids: readonly string[], seed: string): string[] {
  const key = (id: string) => createHash("sha256").update(`${seed}\0${id}`).digest("hex");
  return [...ids].sort((a, b) => key(a).localeCompare(key(b)));
}

/** The system plus up to `max - 1` containers with the most components (then id). Components have no block Overview. */
export function usefulOverviewNodes(snapshot: SnapshotLike, max = 5): string[] {
  const system = snapshot.entities.filter(entity => entity.kind === "softwareSystem").map(entity => String(entity.id)).sort();
  const components = (id: string) => snapshot.entities.filter(child => child.parentId === id && child.kind === "component").length;
  const containers = snapshot.entities.filter(entity => entity.kind === "container").map(entity => String(entity.id))
    .sort((a, b) => components(b) - components(a) || a.localeCompare(b));
  return [...system.slice(0, 1), ...containers].slice(0, Math.max(1, max));
}

// ---------------------------------------------------------------------------
// Metrics (fixtures/cross-repo-eval/metrics.json)

type Num = number | null;
/** Means over labeled nodes; `omittedRendered` is a count (sum over nodes), not a mean. */
export interface BlockAgreement { tau: Num; top1: Num; top3: Num; top1Unrestricted: Num; omittedRendered: number; keptDropped: number }
export interface QuestionMetrics { id: string; family: string; category?: string; stale?: true; recall5: number; recall10: number; recallFull: number; indexedExpected: Num; variants: Record<string, number>; answer?: { citedRecall: number; citationPrecision: Num; invalid: boolean; declined: boolean; correct: boolean; mentions: number; mustMention: number } }
export interface RepoMetrics {
  slug: string; repository: string; language?: string; shape?: string;
  scan?: { asIs: { ok: boolean; ms: number; entities?: number; error?: string }; prepared?: { ok: boolean; ms: number; entities?: number; containers?: number; components?: number; error?: string }; evalPrepare?: EvalPrepare; signals?: RepoSignals };
  /** `byStatus` / `overviewsByStatus`: label status counts (checked vs draft; `rejected` items are not scored). */
  labels?: { questions: number; byStatus: Record<string, number>; overviews: number; overviewsByStatus: Record<string, number>; c4Verdict?: string };
  retrieval?: { corpus?: AskCorpus; questions: number; stale: number; recall5: Num; recall10: Num; recallFull: Num; indexedExpected: Num; meanBytes: Num; meanSections: Num };
  variants?: Record<string, { recallFull: Num; meanBytes: Num; meanSections: Num }>;
  answers?: { answered: number; citedRecall: Num; citationPrecision: Num; invalidRate: Num; declinedRate: Num; correctness: Num; costUsd: number };
  blocks?: { labeled: number; default: BlockAgreement; jev: BlockAgreement & { nodes: number; unavailable: number }; jevCostUsd: number };
  claims?: ReturnType<typeof claimRates> & { costUsd: number; costEstimated: boolean; reservationEquivalentUsd: number };
  cost?: { enrichFailuresByClass?: Record<string, number>; enrichMaxConcurrent?: number; claimsMaxConcurrent?: number; askMaxConcurrent?: number; jevReservationEquivalentUsd?: number; stageMs?: Partial<Record<StageName, number>>; rateLimited?: { enrich: number; claims: number; ask: number }; enrichScope?: string; enrichSkipped?: string; scanMs?: number; preparedScanMs?: number; enrichMs?: number; enrichUsd?: number; enrichRequests?: number; enrichAccepted?: number; enrichFailed?: number; enrichNotRun?: number; systemExplained?: boolean; askUsd: number; jevUsd: number };
  perQuestion: QuestionMetrics[];
}
export interface CrossRepoMetrics {
  schema: typeof METRICS_SCHEMA;
  repos: RepoMetrics[];
  overall: {
    repos: number; scannedAsIs: number; scannedPrepared: number;
    /** How each overall figure is aggregated (pooled rows vs per-question vs mean of per-repo means). */
    aggregation: Record<string, string>;
    retrieval: { questions: number; recall5: Num; recall10: Num; recallFull: Num; indexedExpected: Num; perRepoMean: { repos: number; recall5: Num; recall10: Num; recallFull: Num }; byCategory: Record<string, { questions: number; recallFull: Num }> };
    answers: { answered: number; citedRecall: Num; citationPrecision: Num; invalidRate: Num; declinedRate: Num; correctness: Num; perRepoMean: { repos: number; citedRecall: Num; citationPrecision: Num; declinedRate: Num; correctness: Num } };
    blocks: { labeled: number; jevNodes: number; default: BlockAgreement; jev: BlockAgreement; perRepoMean: { repos: number; default: Omit<BlockAgreement, "omittedRendered" | "keptDropped">; jev: Omit<BlockAgreement, "omittedRendered" | "keptDropped"> } };
    claims: { checked: number; judged: number; unavailableRate: Num; insufficientContextRate: Num; insufficientRate: Num; supportedRate: Num; insufficientContextByReason: Record<string, number>; unavailableByReason: Record<string, number> };
    spendUsd: { enrich: number; ask: number; jev: number; jevReservationEquivalent: number };
    stageMs: Partial<Record<StageName, number>> & { total: number };
    rateLimited: number;
  };
  adaptive: Record<string, { description: string; recallFull: Num; meanBytes: Num; helpsIn: string[]; hurtsIn: string[] }>;
}

function roundRecord<T>(value: T): T {
  if (typeof value === "number") return round(value) as T;
  if (Array.isArray(value)) return value.map(roundRecord) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundRecord(item)])) as T;
  return value;
}

/** Labels that are scored: everything except `status: "rejected"` (draft and checked both count). */
export function scoredLabels<T extends { status?: string }>(items: readonly T[] | undefined): T[] {
  return (items ?? []).filter(item => item.status !== "rejected");
}

interface BlockRow { agreement: ReturnType<typeof orderAgreement>; omitted: number; dropped: number }
function blockSummary(rows: readonly BlockRow[]): BlockAgreement {
  const pick = (key: "tau" | "top1" | "top3" | "top1Unrestricted") => mean(rows.map(row => row.agreement?.[key] ?? null).filter((value): value is number => value !== null));
  return { tau: pick("tau"), top1: pick("top1"), top3: pick("top3"), top1Unrestricted: pick("top1Unrestricted"), omittedRendered: rows.reduce((sum, row) => sum + row.omitted, 0), keptDropped: rows.reduce((sum, row) => sum + row.dropped, 0) };
}

function sumCounts(list: ReadonlyArray<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const counts of list) for (const [key, value] of Object.entries(counts)) out[key] = (out[key] ?? 0) + value;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** "full", or "sampled k=<components kept per container> (<kept>/<all> components)" with the K actually used. */
export function enrichScopeLabel(scope: EnrichmentScope | undefined): string {
  if (!scope || scope.mode === "full") return "full";
  const perContainer = scope.containers === 1 ? scope.singleContainerK ?? scope.k : scope.k;
  return `sampled k=${perContainer} (${scope.componentsSampled}/${scope.componentsFull} components)`;
}

export function computeMetrics(manifest: CrossRepoManifest, labels: ReadonlyMap<string, CrossRepoLabels>, runs: ReadonlyMap<string, CrossRepoRun>): CrossRepoMetrics {
  const repos: RepoMetrics[] = [];
  const pooled: Array<{ key: string; value: QuestionMetrics }> = [];
  const allBlockRows: { default: BlockRow[]; jev: BlockRow[] } = { default: [], jev: [] };
  const variantRepoRecall = new Map<string, Map<string, number | null>>();
  for (const repo of manifest.repos) {
    const run = runs.get(repo.slug);
    const label = labels.get(repo.slug);
    if (!run && !label) continue;
    const metrics: RepoMetrics = { slug: repo.slug, repository: repo.repository, ...(repo.language ? { language: repo.language } : {}), ...(repo.shape ? { shape: repo.shape } : {}), perQuestion: [] };
    const fresh = run?.commitSha === repo.commitSha;
    if (run?.scan && fresh) {
      const { asIs, prepared } = run.scan;
      metrics.scan = {
        asIs: { ok: asIs.ok, ms: asIs.ms, ...(asIs.entities !== undefined ? { entities: asIs.entities } : {}), ...(asIs.error ? { error: asIs.error } : {}) },
        ...(prepared ? { prepared: { ok: prepared.ok, ms: prepared.ms, ...(prepared.entities !== undefined ? { entities: prepared.entities } : {}), ...(prepared.kinds ? { containers: prepared.kinds.container ?? 0, components: prepared.kinds.component ?? 0 } : {}), ...(prepared.error ? { error: prepared.error } : {}) } } : {}),
        ...(run.evalPrepare ? { evalPrepare: run.evalPrepare } : {}),
        ...((prepared ?? asIs).signals ? { signals: (prepared ?? asIs).signals! } : {}),
      };
    }
    const statusCounts = (items: ReadonlyArray<{ status?: string }>) => items.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.status ?? "unset"]: (counts[item.status ?? "unset"] ?? 0) + 1 }), {});
    if (label) metrics.labels = { questions: label.questions.length, byStatus: statusCounts(label.questions), overviews: label.overviews?.length ?? 0, overviewsByStatus: statusCounts(label.overviews ?? []), ...(label.c4Note?.verdict ? { c4Verdict: label.c4Note.verdict } : {}) };

    // Retrieval + answers
    const ask = fresh ? run?.ask : undefined;
    const rows: QuestionMetrics[] = [];
    let stale = 0; let askUsd = 0;
    const bytes: number[] = []; const sections: number[] = [];
    const variantStats = new Map<string, { bytes: number[]; sections: number[] }>();
    for (const question of scoredLabels(label?.questions)) {
      const recorded = ask?.questions.find(item => item.id === question.id);
      if (!recorded) continue;
      if (recorded.question !== question.question || recorded.selectedId !== question.selection.selectedId) { stale += 1; continue; }
      const paths = ask!.paths;
      const ranked = recorded.ranked.map(index => paths[index]!);
      const evidence = [...ranked, ...recorded.packets.map(index => paths[index]!)];
      const known = question.expectedFiles.filter(path => path in recorded.expectedIndexed);
      const variants: Record<string, number> = {};
      for (const [name, variant] of Object.entries(recorded.variants)) {
        variants[name] = recallAtK(question.expectedFiles, [...variant.ranked.map(index => paths[index]!), ...recorded.packets.map(index => paths[index]!)]);
        const stats = variantStats.get(name) ?? { bytes: [], sections: [] }; stats.bytes.push(variant.bytes); stats.sections.push(variant.sectionCount); variantStats.set(name, stats);
      }
      bytes.push(recorded.bytes); sections.push(recorded.sectionCount);
      const row: QuestionMetrics = {
        id: question.id, family: question.family, ...(question.category ? { category: question.category } : {}),
        recall5: recallAtK(question.expectedFiles, ranked, 5), recall10: recallAtK(question.expectedFiles, ranked, 10), recallFull: recallAtK(question.expectedFiles, evidence),
        indexedExpected: known.length ? known.filter(path => recorded.expectedIndexed[path]).length / known.length : null,
        variants,
      };
      const scored = scoreRecordedAnswer(recorded, paths, question.expectedFiles, question.mustMention);
      if (scored) {
        row.answer = { citedRecall: scored.citedRecall, citationPrecision: scored.citationPrecision, invalid: scored.invalid, declined: scored.declined, correct: scored.correct, mentions: scored.mentions, mustMention: question.mustMention.length };
        askUsd += usageUsd(recorded.answer!.usage).usd;
      }
      rows.push(row);
    }
    metrics.perQuestion = rows;
    const keyed = rows.map(row => ({ key: `${repo.slug}:${row.family}`, value: row }));
    pooled.push(...keyed);
    if (rows.length || stale) {
      metrics.retrieval = { ...(ask?.corpus ? { corpus: ask.corpus } : {}), questions: rows.length, stale, recall5: familyMeanOf(keyed, row => row.recall5), recall10: familyMeanOf(keyed, row => row.recall10), recallFull: familyMeanOf(keyed, row => row.recallFull), indexedExpected: familyMeanOf(keyed, row => row.indexedExpected), meanBytes: mean(bytes), meanSections: mean(sections) };
      metrics.variants = { default: { recallFull: metrics.retrieval.recallFull, meanBytes: mean(bytes), meanSections: mean(sections) } };
      for (const [name, stats] of [...variantStats].sort(([a], [b]) => a.localeCompare(b))) metrics.variants[name] = { recallFull: familyMeanOf(keyed, row => row.variants[name] ?? null), meanBytes: mean(stats.bytes), meanSections: mean(stats.sections) };
      for (const [name, value] of Object.entries(metrics.variants)) { const byRepo = variantRepoRecall.get(name) ?? new Map(); byRepo.set(repo.slug, value.recallFull); variantRepoRecall.set(name, byRepo); }
    }
    const answered = keyed.filter(row => row.value.answer);
    if (answered.length) {
      metrics.answers = {
        answered: answered.length,
        citedRecall: familyMeanOf(answered, row => row.answer!.citedRecall),
        citationPrecision: familyMeanOf(answered, row => row.answer!.citationPrecision),
        invalidRate: familyMeanOf(answered, row => row.answer!.invalid ? 1 : 0),
        declinedRate: familyMeanOf(answered, row => row.answer!.declined ? 1 : 0),
        correctness: familyMeanOf(answered, row => row.answer!.correct ? 1 : 0),
        costUsd: askUsd,
      };
    }

    // Blocks
    const overviews = scoredLabels(label?.overviews);
    const blockNodes = fresh ? run?.blocks?.nodes ?? [] : [];
    const jevCostUsd = blockNodes.reduce((sum, node) => sum + (node.jev?.estimatedCostUsd ?? 0), 0);
    // A planner request was sent when latency was recorded (the product reserves $0.003 for each).
    const jevBlockRequests = blockNodes.filter(node => node.jev?.latencyMs !== undefined).length;
    if (overviews.length || blockNodes.some(node => node.jev)) {
      const byDefault: BlockRow[] = []; const byJev: BlockRow[] = [];
      let jevUnavailable = 0;
      for (const overview of overviews) {
        const node = blockNodes.find(item => item.nodeId === overview.nodeId);
        if (!node) continue;
        const candidateIds = node.candidates.map(candidate => candidate.id);
        byDefault.push({ agreement: orderAgreement(overview.order, node.defaultOrder), omitted: omittedButRendered(overview.order, node.defaultOrder), dropped: keptButDropped(overview.order, node.defaultOrder, candidateIds) });
        if (node.jev?.order) byJev.push({ agreement: orderAgreement(overview.order, node.jev.order), omitted: omittedButRendered(overview.order, node.jev.order), dropped: keptButDropped(overview.order, node.jev.order, candidateIds) });
        else if (node.jev?.unavailable) jevUnavailable += 1;
      }
      metrics.blocks = { labeled: byDefault.length, default: blockSummary(byDefault), jev: { nodes: byJev.length, unavailable: jevUnavailable, ...blockSummary(byJev) }, jevCostUsd };
      allBlockRows.default.push(...byDefault); allBlockRows.jev.push(...byJev);
    }

    // Claims
    const claims = fresh ? run?.claims : undefined;
    if (claims) metrics.claims = { ...claimRates(claims.rows), costUsd: claims.costUsd, costEstimated: claims.costEstimated, reservationEquivalentUsd: claims.reservationEquivalentUsd ?? claims.requests * JEV_RESERVATION_USD_PER_REQUEST };

    // Cost / time
    if (run && fresh) {
      const enrichment = run.enrichment?.mode === "live" ? run.enrichment : undefined;
      metrics.cost = {
        ...(run.stageMs ? { stageMs: run.stageMs } : {}),
        ...(enrichment?.rateLimited !== undefined || claims?.rateLimited !== undefined || ask?.rateLimited !== undefined ? { rateLimited: { enrich: enrichment?.rateLimited ?? 0, claims: claims?.rateLimited ?? 0, ask: ask?.rateLimited ?? 0 } } : {}),
        ...(enrichment ? { enrichScope: enrichScopeLabel(enrichment.scope) } : {}),
        ...(enrichment?.failures?.length ? { enrichFailuresByClass: enrichment.failures.reduce<Record<string, number>>((counts, failure) => ({ ...counts, [failure.class]: (counts[failure.class] ?? 0) + 1 }), {}) } : {}),
        ...(enrichment ? { enrichMaxConcurrent: enrichment.caps.maxConcurrent } : {}),
        ...(claims?.caps ? { claimsMaxConcurrent: claims.caps.maxConcurrent } : {}),
        ...(ask?.caps ? { askMaxConcurrent: ask.caps.maxConcurrent } : {}),
        jevReservationEquivalentUsd: (claims?.mode === "live" ? claims.reservationEquivalentUsd ?? claims.requests * JEV_RESERVATION_USD_PER_REQUEST : 0) + jevBlockRequests * JEV_RESERVATION_USD_PER_REQUEST,
        ...(run.enrichmentSkipped ? { enrichSkipped: run.enrichmentSkipped.reason } : {}),
        ...(run.scan ? { scanMs: run.scan.asIs.ms } : {}),
        ...(run.scan?.prepared ? { preparedScanMs: run.scan.prepared.ms } : {}),
        ...(enrichment ? { enrichMs: enrichment.ms, enrichUsd: enrichment.costUsd, enrichRequests: enrichment.requests, enrichAccepted: enrichment.coverage.accepted, enrichFailed: enrichment.coverage.failed, enrichNotRun: enrichment.coverage.notRun, systemExplained: enrichment.systemExplained } : {}),
        askUsd, jevUsd: (claims?.mode === "live" ? claims.costUsd : 0) + jevCostUsd,
      };
    }
    repos.push(metrics);
  }

  const answered = pooled.filter(row => row.value.answer);
  const categories = [...new Set(pooled.map(row => row.value.category ?? "uncategorized"))].sort();
  const blockRepos = repos.filter(repo => repo.blocks?.labeled);
  const claimRows = repos.flatMap(repo => repo.claims ? [repo.claims] : []);
  const claimTotal = claimRows.reduce((sum, row) => sum + row.checked, 0);
  const claimJudged = claimRows.reduce((sum, row) => sum + row.judged, 0);
  const claimCount = (state: string) => claimRows.reduce((sum, row) => sum + (row.byState[state] ?? 0), 0);
  const defaultRecall = variantRepoRecall.get("default") ?? new Map<string, number | null>();
  const adaptive: CrossRepoMetrics["adaptive"] = {};
  for (const variant of RETRIEVAL_VARIANTS) {
    const byRepo = variantRepoRecall.get(variant.name);
    if (!byRepo) continue;
    const helpsIn: string[] = []; const hurtsIn: string[] = [];
    for (const [slug, value] of byRepo) { const base = defaultRecall.get(slug); if (value === null || base === null || base === undefined) continue; if (value > base + 1e-9) helpsIn.push(slug); else if (value < base - 1e-9) hurtsIn.push(slug); }
    adaptive[variant.name] = {
      description: variant.description,
      recallFull: familyMeanOf(pooled, row => variant.name === "default" ? row.recallFull : row.variants[variant.name] ?? null),
      meanBytes: mean(repos.map(repo => repo.variants?.[variant.name]?.meanBytes ?? null).filter((value): value is number => value !== null)),
      helpsIn, hurtsIn,
    };
  }
  const perRepoMean = (pick: (repo: RepoMetrics) => Num | undefined) => mean(repos.map(pick).filter((value): value is number => typeof value === "number"));
  const retrievalRepos = repos.filter(repo => repo.retrieval?.questions);
  const answerRepos = repos.filter(repo => repo.answers);
  const stageMs: CrossRepoMetrics["overall"]["stageMs"] = { total: 0 };
  for (const repo of repos) for (const [name, ms] of Object.entries(repo.cost?.stageMs ?? {}) as Array<[StageName, number]>) { stageMs[name] = (stageMs[name] ?? 0) + ms; stageMs.total += ms; }
  const blockMean = (pick: (repo: RepoMetrics) => Num) => mean(blockRepos.map(pick).filter((value): value is number => value !== null));
  const repoMeans = (which: "default" | "jev") => ({ tau: blockMean(repo => repo.blocks![which].tau), top1: blockMean(repo => repo.blocks![which].top1), top3: blockMean(repo => repo.blocks![which].top3), top1Unrestricted: blockMean(repo => repo.blocks![which].top1Unrestricted) });
  const result: CrossRepoMetrics = {
    schema: METRICS_SCHEMA,
    repos,
    overall: {
      repos: repos.length,
      scannedAsIs: repos.filter(repo => repo.scan?.asIs.ok).length,
      scannedPrepared: repos.filter(repo => (repo.scan?.prepared ?? repo.scan?.asIs)?.ok).length,
      aggregation: {
        "retrieval.recall*": "mean of per-family means, families pooled across repos (a repo counts by its number of families)",
        "retrieval.perRepoMean": "mean over repos of each repo's family-mean (every repo weighs the same)",
        "retrieval.byCategory": "mean of per-family means within the category, pooled across repos",
        "answers.*": "mean of per-family means over answered questions, pooled across repos",
        "answers.perRepoMean": "mean over answered repos of each repo's family-mean",
        "blocks.default/jev": "mean over labeled nodes pooled across repos (tau/top-k on shared candidates: nodes where it is undefined, e.g. one shared block, are skipped); omittedRendered = sum over nodes of rendered blocks missing from the hand order; keptDropped = sum over nodes of hand-kept candidate blocks the order does not render",
        "blocks.perRepoMean": "mean over repos of each repo's per-node mean",
        "claims.*": "pooled claim rows across repos; rates over judged (= checked − unavailable), unavailableRate over checked",
        "spendUsd.*": "sum over repos (jevReservationEquivalent = $0.003 per Jev request: claim checks + block planner)",
        "labels": "items with status \"rejected\" are excluded from every score; draft and checked both count",
        "rateLimited": "sum of live 429s across repos and stages (backed off + retried, never silently dropped)",
        "stageMs.*": "sum of each repo's last-pass wall time (repos may have run in parallel)",
      },
      retrieval: {
        questions: pooled.length,
        recall5: familyMeanOf(pooled, row => row.recall5), recall10: familyMeanOf(pooled, row => row.recall10), recallFull: familyMeanOf(pooled, row => row.recallFull),
        indexedExpected: familyMeanOf(pooled, row => row.indexedExpected),
        perRepoMean: { repos: retrievalRepos.length, recall5: perRepoMean(repo => repo.retrieval?.recall5), recall10: perRepoMean(repo => repo.retrieval?.recall10), recallFull: perRepoMean(repo => repo.retrieval?.recallFull) },
        byCategory: Object.fromEntries(categories.map(category => { const rows = pooled.filter(row => (row.value.category ?? "uncategorized") === category); return [category, { questions: rows.length, recallFull: familyMeanOf(rows, row => row.recallFull) }]; })),
      },
      answers: {
        answered: answered.length,
        citedRecall: familyMeanOf(answered, row => row.answer!.citedRecall), citationPrecision: familyMeanOf(answered, row => row.answer!.citationPrecision),
        invalidRate: familyMeanOf(answered, row => row.answer!.invalid ? 1 : 0),
        declinedRate: familyMeanOf(answered, row => row.answer!.declined ? 1 : 0), correctness: familyMeanOf(answered, row => row.answer!.correct ? 1 : 0),
        perRepoMean: { repos: answerRepos.length, citedRecall: perRepoMean(repo => repo.answers?.citedRecall), citationPrecision: perRepoMean(repo => repo.answers?.citationPrecision), declinedRate: perRepoMean(repo => repo.answers?.declinedRate), correctness: perRepoMean(repo => repo.answers?.correctness) },
      },
      blocks: {
        labeled: blockRepos.reduce((sum, repo) => sum + repo.blocks!.labeled, 0),
        jevNodes: allBlockRows.jev.length,
        default: blockSummary(allBlockRows.default), jev: blockSummary(allBlockRows.jev),
        perRepoMean: { repos: blockRepos.length, default: repoMeans("default"), jev: repoMeans("jev") },
      },
      claims: {
        checked: claimTotal, judged: claimJudged, unavailableRate: claimTotal ? claimCount("unavailable") / claimTotal : null,
        insufficientContextRate: claimJudged ? claimCount("insufficient-context") / claimJudged : null, insufficientRate: claimJudged ? claimCount("insufficient") / claimJudged : null, supportedRate: claimJudged ? claimCount("supported") / claimJudged : null,
        insufficientContextByReason: sumCounts(claimRows.map(row => row.insufficientContextByReason)), unavailableByReason: sumCounts(claimRows.map(row => row.unavailableByReason)),
      },
      spendUsd: {
        enrich: repos.reduce((sum, repo) => sum + (repo.cost?.enrichUsd ?? 0), 0),
        ask: repos.reduce((sum, repo) => sum + (repo.cost?.askUsd ?? 0), 0),
        jev: repos.reduce((sum, repo) => sum + (repo.cost?.jevUsd ?? 0), 0),
        jevReservationEquivalent: repos.reduce((sum, repo) => sum + (repo.cost?.jevReservationEquivalentUsd ?? 0), 0),
      },
      stageMs,
      rateLimited: repos.reduce((sum, repo) => sum + (repo.cost?.rateLimited ? repo.cost.rateLimited.enrich + repo.cost.rateLimited.claims + repo.cost.rateLimited.ask : 0), 0),
    },
    adaptive,
  };
  return roundRecord(result);
}
