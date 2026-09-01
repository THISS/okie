import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { inspect } from "node:util";
import { scrubGithubTokens } from "@okie/scan";

/**
 * OpenAI-compatible LLM gateway config + client construction (CLA-20).
 *
 * OpenRouter-first: the published default base URL is OpenRouter's v1 endpoint.
 * Keys are env-only (`.env` / process env). Local config may set base URL and
 * model id but is never a key source. The Anthropic env sniff remains a
 * fallback for the existing SDK path; it does not become a gateway credential.
 */

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Documented default model id in OpenRouter's `provider/model` form. Not a table. */
export const DEFAULT_GATEWAY_MODEL_ID = "anthropic/claude-sonnet-4";

export const LOCAL_LLM_CONFIG_FILENAME = "okie.local.json";

export type LlmKeySource = "gateway" | "anthropic-fallback" | "none";

/** Non-secret overlay. Keys are not part of this type and are ignored if a file contains them. */
export interface LlmGatewayLocalConfig {
  baseUrl?: string;
  modelId?: string;
}

export interface LlmGatewayConfig {
  baseUrl: string;
  modelId: string;
  keySource: LlmKeySource;
  /** Present only when a key was resolved. Never serialize, log, or put on /healthz. */
  apiKey?: string;
}

export interface LlmGatewayPublicView {
  /** Origin + path only. Userinfo and query (where tokens hide) are stripped. */
  baseUrl: string;
  modelId: string;
  keySource: LlmKeySource;
  keyConfigured: boolean;
}

export interface LlmGatewayClientOptions {
  fetch?: typeof fetch;
  /** Per-request deadline for `chatCompletions`. Default `DEFAULT_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Per-request HTTP deadline so a hung gateway cannot stall a paste-a-repo job. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Scan-level cap on gateway calls (container scopes + system). */
export const DEFAULT_MAX_ENRICHMENT_SCOPES = 16;
/** Scan-level cap on reported tokens (`usage.total_tokens` / prompt+completion). */
export const DEFAULT_MAX_ENRICHMENT_TOKENS = 200_000;
/** Scan-level dollar cap, applied only when the gateway reports cost. */
export const DEFAULT_MAX_ENRICHMENT_DOLLARS = 1;

export type LlmGatewayFailureKind = "timeout" | "rate_limit" | "server" | "http";

export interface EnrichmentBudget {
  requestTimeoutMs: number;
  maxScopes: number;
  maxTokens: number;
  /** Enforced only when a response reports `usage.cost` (or equivalent). */
  maxDollars: number;
}

export interface GatewayUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  costUsd?: number;
}

export class LlmGatewayError extends Error {
  readonly kind: LlmGatewayFailureKind;
  readonly status?: number;

  constructor(message: string, options: { kind: LlmGatewayFailureKind; status?: number; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LlmGatewayError";
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function classifyLlmGatewayFailure(error: unknown): LlmGatewayFailureKind | undefined {
  if (error instanceof LlmGatewayError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = /llm gateway (\d{3})\b/.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 429) return "rate_limit";
    if (status >= 500 && status <= 599) return "server";
    return "http";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  if (/llm gateway timeout/i.test(message) || /\btimeout after \d+ms\b/i.test(message)) {
    return "timeout";
  }
  return undefined;
}

/** Rate-limit and 5xx abort the rest of the scan's enrichment pass. */
export function shouldSkipRemainingScopes(error: unknown): boolean {
  const kind = classifyLlmGatewayFailure(error);
  return kind === "rate_limit" || kind === "server";
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = optionalFiniteNumber(raw);
  if (parsed === undefined || parsed <= 0) return fallback;
  return parsed;
}

/** Operator env overlay. Missing / invalid values keep the documented defaults. */
export function resolveEnrichmentBudget(env: NodeJS.Dict<string> = process.env): EnrichmentBudget {
  return {
    requestTimeoutMs: Math.floor(parsePositiveNumber(env.OKIE_LLM_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)),
    maxScopes: Math.floor(parsePositiveNumber(env.OKIE_LLM_MAX_SCOPES, DEFAULT_MAX_ENRICHMENT_SCOPES)),
    maxTokens: Math.floor(parsePositiveNumber(env.OKIE_LLM_MAX_TOKENS, DEFAULT_MAX_ENRICHMENT_TOKENS)),
    maxDollars: parsePositiveNumber(env.OKIE_LLM_MAX_DOLLARS, DEFAULT_MAX_ENRICHMENT_DOLLARS),
  };
}

export function llmGatewayErrorFromHttp(status: number, body: string, apiKey?: string): LlmGatewayError {
  const kind: LlmGatewayFailureKind = status === 429
    ? "rate_limit"
    : status >= 500 && status <= 599
      ? "server"
      : "http";
  return new LlmGatewayError(`llm gateway ${status}: ${redactGatewayText(body, apiKey)}`, { kind, status });
}

/**
 * OpenAI-compatible `usage` plus OpenRouter `cost` / `x-openrouter-cost`.
 * Returns `undefined` when the payload has neither token counts nor a cost.
 */
export function readGatewayUsage(json: unknown, headerCostUsd?: number): GatewayUsage | undefined {
  const record = typeof json === "object" && json !== null ? json as Record<string, unknown> : undefined;
  const usage = record && typeof record.usage === "object" && record.usage !== null
    ? record.usage as Record<string, unknown>
    : undefined;
  const promptTokens = optionalFiniteNumber(usage?.prompt_tokens) ?? optionalFiniteNumber(usage?.input_tokens);
  const completionTokens = optionalFiniteNumber(usage?.completion_tokens) ?? optionalFiniteNumber(usage?.output_tokens);
  const reportedTotal = optionalFiniteNumber(usage?.total_tokens);
  const totalTokens = reportedTotal
    ?? ((promptTokens ?? 0) + (completionTokens ?? 0) || undefined);
  const costUsd = optionalFiniteNumber(usage?.cost)
    ?? optionalFiniteNumber(usage?.total_cost)
    ?? optionalFiniteNumber(usage?.cost_usd)
    ?? headerCostUsd;
  if (totalTokens === undefined && costUsd === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    totalTokens: totalTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function headerCostUsd(headers: Headers): number | undefined {
  return optionalFiniteNumber(headers.get("x-openrouter-cost"))
    ?? optionalFiniteNumber(headers.get("x-openai-cost"));
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/** Rejects with `LlmGatewayError` (`timeout`) when `work` does not settle in time. */
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LlmGatewayError(`llm gateway timeout after ${timeoutMs}ms`, { kind: "timeout" }));
      }, timeoutMs);
      work.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface LlmChatCompletionResult {
  json: unknown;
  usage?: GatewayUsage;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = trimToUndefined(value);
    if (trimmed) return trimmed;
  }
  return undefined;
}

function envHasKey(env: NodeJS.Dict<string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

/**
 * Model id is an opaque gateway string. Unset → documented default.
 * A present-but-empty source (env or local) wins as empty so the enrichment
 * pass can fail closed instead of silently substituting the default (CLA-21).
 */
function resolveModelId(env: NodeJS.Dict<string>, local: LlmGatewayLocalConfig): string {
  const sources: Array<{ present: boolean; raw: string | undefined }> = [
    { present: local.modelId !== undefined, raw: local.modelId },
    { present: envHasKey(env, "OKIE_LLM_MODEL"), raw: env.OKIE_LLM_MODEL },
    { present: envHasKey(env, "OPENROUTER_MODEL"), raw: env.OPENROUTER_MODEL },
    { present: envHasKey(env, "OPENAI_MODEL"), raw: env.OPENAI_MODEL },
  ];
  for (const source of sources) {
    if (!source.present) continue;
    return source.raw?.trim() ?? "";
  }
  return DEFAULT_GATEWAY_MODEL_ID;
}

/** Non-empty after trim. Okie does not validate against a model table. */
export function isUsableModelId(modelId: string | undefined): boolean {
  return Boolean(trimToUndefined(modelId));
}

/**
 * Throws when the operator configured an empty model id. Callers map this to
 * an enrichment-pass failure, not a failed job.
 */
export function requireUsableModelId(modelId: string | undefined): string {
  const trimmed = trimToUndefined(modelId);
  if (!trimmed) {
    throw new Error("empty model id");
  }
  return trimmed;
}

function withApiKey(base: Omit<LlmGatewayConfig, "apiKey">, apiKey: string): LlmGatewayConfig {
  const config: LlmGatewayConfig = { ...base };
  Object.defineProperty(config, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(config, inspect.custom, {
    value: () => publicLlmGatewayView(config),
    enumerable: false,
  });
  return config;
}

function gatewayKeyFromEnv(env: NodeJS.Dict<string>): string | undefined {
  return firstNonEmpty([env.OKIE_LLM_API_KEY, env.OPENROUTER_API_KEY, env.OPENAI_API_KEY]);
}

function anthropicKeyFromEnv(env: NodeJS.Dict<string>): string | undefined {
  return firstNonEmpty([env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN]);
}

/** Origin + pathname, with userinfo/query/hash stripped. Never throws. */
export function publicGatewayBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[redacted-url]";
  }
}

/** Safe snapshot for logs / inspect / health-adjacent views. Never includes the key. */
export function publicLlmGatewayView(config: LlmGatewayConfig): LlmGatewayPublicView {
  return {
    baseUrl: publicGatewayBaseUrl(config.baseUrl),
    modelId: config.modelId,
    keySource: config.keySource,
    keyConfigured: Boolean(config.apiKey),
  };
}

/**
 * Replace every occurrence of `secret` in `text`. No-op when the secret is
 * empty. Used before logs and job notes so a provider error cannot echo a key.
 */
export function redactLlmSecret(text: string, secret: string | undefined): string {
  const value = trimToUndefined(secret);
  if (!value) return text;
  return text.split(value).join("[redacted-llm-key]");
}

/**
 * Hostname of a gateway URL, never userinfo or query. `undefined` when the
 * string is not a usable URL — callers must not fall back to the raw value.
 */
export function safeGatewayProvider(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.trim().toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Provider label for job/UI. Anthropic fallback and force-without-gateway-key
 * (profile auth) are named "anthropic". A gateway key uses the hostname only.
 * Never a URL, never a key.
 */
export function enrichmentProviderLabel(
  config: LlmGatewayConfig,
  mode: "off" | "force" | "auto" = "auto",
): string | undefined {
  if (config.keySource === "anthropic-fallback") return "anthropic";
  if (config.keySource === "gateway") return safeGatewayProvider(config.baseUrl);
  if (mode === "force") return "anthropic";
  return safeGatewayProvider(config.baseUrl);
}

/**
 * Configured model id when non-empty and not a secret. If the operator pasted
 * a key or tokenized URL into the model field, omit it rather than publish it.
 */
export function enrichmentModelId(config: LlmGatewayConfig): string | undefined {
  if (!isUsableModelId(config.modelId)) return undefined;
  const trimmed = config.modelId.trim();
  const redacted = redactGatewayText(trimmed, config.apiKey);
  return redacted === trimmed ? trimmed : undefined;
}

/**
 * Strip userinfo, query, and fragment from http(s) URLs in `text`. Tokens in
 * `https://user:token@host/path?api_key=` must not reach logs, job.error, or UI.
 * Trailing sentence punctuation is preserved; commas inside userinfo are not
 * treated as URL terminators.
 */
export function redactTokenizedUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    const trailingMatch = /[.,;:!?)]+$/.exec(raw);
    const core = trailingMatch ? raw.slice(0, trailingMatch.index) : raw;
    const suffix = trailingMatch ? trailingMatch[0] : "";
    try {
      const parsed = new URL(core);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        return raw;
      }
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return `${parsed.toString()}${suffix}`;
    } catch {
      return `[redacted-url]${suffix}`;
    }
  });
}

/**
 * Last-mile scrub for anything that leaves toward the gateway, logs, or job.error:
 * existing GitHub token patterns, tokenized gateway URLs, plus the operator's exact API key.
 */
export function redactGatewayText(text: string, secret?: string): string {
  return redactLlmSecret(redactTokenizedUrls(scrubGithubTokens(text)), secret);
}

export function hasLlmCredentials(config: LlmGatewayConfig): boolean {
  return config.keySource !== "none";
}

/**
 * Resolves gateway settings. Local overlay wins for base URL / model id.
 * Keys come only from env (gateway vars first, then ANTHROPIC_* fallback).
 */
export function resolveLlmGatewayConfig(
  env: NodeJS.Dict<string> = process.env,
  local: LlmGatewayLocalConfig = {},
): LlmGatewayConfig {
  const baseUrl = firstNonEmpty([
    local.baseUrl,
    env.OKIE_LLM_BASE_URL,
    env.OPENAI_BASE_URL,
  ]) ?? DEFAULT_OPENROUTER_BASE_URL;
  const modelId = resolveModelId(env, local);

  const gatewayKey = gatewayKeyFromEnv(env);
  if (gatewayKey) {
    return withApiKey({ baseUrl, modelId, keySource: "gateway" }, gatewayKey);
  }
  const anthropicKey = anthropicKeyFromEnv(env);
  if (anthropicKey) {
    return withApiKey({ baseUrl, modelId, keySource: "anthropic-fallback" }, anthropicKey);
  }
  return { baseUrl, modelId, keySource: "none" };
}

/**
 * Reads a local overlay JSON. Only `baseUrl` and `modelId` are accepted.
 * An `apiKey` (or any other secret-looking field) is ignored so a misplaced
 * key in a config file cannot become the live credential.
 */
export function readLlmGatewayLocalConfigFile(path: string): LlmGatewayLocalConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`LLM local config must be a JSON object: ${path}`);
  }
  const record = raw as Record<string, unknown>;
  const local: LlmGatewayLocalConfig = {};
  if (typeof record.baseUrl === "string") {
    const baseUrl = trimToUndefined(record.baseUrl);
    if (baseUrl) local.baseUrl = baseUrl;
  }
  if (typeof record.modelId === "string") {
    // Preserve present-but-empty so CLA-21 can fail the enrichment pass.
    local.modelId = record.modelId.trim();
  }
  return local;
}

/** `OKIE_LLM_CONFIG` if set, else `<repoRoot>/okie.local.json` when that file exists. */
export function resolveLlmGatewayLocalConfig(
  repoRoot: string,
  env: NodeJS.Dict<string> = process.env,
): LlmGatewayLocalConfig {
  const explicit = trimToUndefined(env.OKIE_LLM_CONFIG);
  const path = explicit
    ? (isAbsolute(explicit) ? explicit : resolve(repoRoot, explicit))
    : join(repoRoot, LOCAL_LLM_CONFIG_FILENAME);
  if (explicit && !existsSync(path)) {
    throw new Error(`OKIE_LLM_CONFIG file not found: ${path}`);
  }
  if (!existsSync(path)) return {};
  return readLlmGatewayLocalConfigFile(path);
}

/** Load repo-root `.env` into `process.env` without overriding existing vars. */
export function loadOperatorDotenv(repoRoot: string): void {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;
  process.loadEnvFile(envPath);
}

/**
 * OpenAI-compatible client. The API key is a private field: JSON, inspect, and
 * error messages never include it. Not constructed for Anthropic-fallback keys
 * (those stay on the Anthropic SDK so they are not sent to the gateway).
 */
export class LlmGatewayClient {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly keySource: "gateway";
  readonly hasApiKey = true;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(config: LlmGatewayConfig, options: LlmGatewayClientOptions = {}) {
    const apiKey = trimToUndefined(config.apiKey);
    if (!apiKey || config.keySource !== "gateway") {
      throw new Error("LlmGatewayClient requires a gateway API key");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.modelId = config.modelId;
    this.keySource = "gateway";
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  toJSON(): LlmGatewayPublicView {
    return {
      baseUrl: publicGatewayBaseUrl(this.baseUrl),
      modelId: this.modelId,
      keySource: this.keySource,
      keyConfigured: true,
    };
  }

  [inspect.custom](): LlmGatewayPublicView {
    return this.toJSON();
  }

  /**
   * POST `{baseUrl}/chat/completions` with a per-request timeout.
   * Packet enrichment drives this (CLA-23). The JSON body is token-scrubbed
   * before it leaves the machine (CLA-25). The deadline and usage parse
   * keep a paste-a-repo job from hanging or running unbounded (CLA-22).
   */
  async chatCompletions(body: Record<string, unknown>): Promise<LlmChatCompletionResult> {
    // Configured model id always wins — body must not override it (CLA-21).
    const payload = { ...body, model: this.modelId };
    const serialized = redactGatewayText(JSON.stringify(payload), this.#apiKey);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: serialized,
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        throw new LlmGatewayError(`llm gateway timeout after ${this.timeoutMs}ms`, {
          kind: "timeout",
          cause: error,
        });
      }
      throw error;
    }
    const text = await response.text();
    if (!response.ok) {
      throw llmGatewayErrorFromHttp(response.status, text, this.#apiKey);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error("llm gateway returned non-JSON");
    }
    const usage = readGatewayUsage(json, headerCostUsd(response.headers));
    return usage ? { json, usage } : { json };
  }
}

/** `undefined` when there is no gateway key (including Anthropic-only fallback). */
export function createLlmGatewayClient(
  config: LlmGatewayConfig,
  options: LlmGatewayClientOptions = {},
): LlmGatewayClient | undefined {
  if (config.keySource !== "gateway" || !trimToUndefined(config.apiKey)) return undefined;
  return new LlmGatewayClient(config, options);
}

export function describeEnrichmentMode(
  mode: "off" | "force" | "auto",
  config: LlmGatewayConfig,
): string {
  if (mode === "off") return "disabled (OKIE_SCAN_ENRICH=0)";
  const modelId = enrichmentModelId(config);
  const modelNote = modelId
    ? `model ${modelId}`
    : isUsableModelId(config.modelId)
      ? "model [redacted]"
      : "empty model id (enrichment pass will fail; atlas still publishes)";
  const provider = enrichmentProviderLabel(config, mode) ?? "configured";
  if (mode === "force") {
    return `forced (OKIE_SCAN_ENRICH=1) ${config.keySource === "gateway" ? "gateway" : "provider"} ${provider} ${modelNote}`;
  }
  if (!hasLlmCredentials(config)) {
    return `auto (no key; enrichment skipped) gateway ${provider} ${modelNote}`;
  }
  if (config.keySource === "anthropic-fallback") {
    return `auto (ANTHROPIC_* fallback) provider ${provider} ${modelNote}`;
  }
  return `auto gateway ${provider} ${modelNote}`;
}
