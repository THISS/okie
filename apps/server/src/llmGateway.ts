import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { inspect } from "node:util";

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
  baseUrl: string;
  modelId: string;
  keySource: LlmKeySource;
  keyConfigured: boolean;
}

export interface LlmGatewayClientOptions {
  fetch?: typeof fetch;
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

/** Safe snapshot for logs / inspect / health-adjacent views. Never includes the key. */
export function publicLlmGatewayView(config: LlmGatewayConfig): LlmGatewayPublicView {
  return {
    baseUrl: config.baseUrl,
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
  }

  toJSON(): LlmGatewayPublicView {
    return {
      baseUrl: this.baseUrl,
      modelId: this.modelId,
      keySource: this.keySource,
      keyConfigured: true,
    };
  }

  [inspect.custom](): LlmGatewayPublicView {
    return this.toJSON();
  }

  /**
   * POST `{baseUrl}/chat/completions`. Packet enrichment will call this in CLA-23;
   * this slice only constructs the client.
   */
  async chatCompletions(body: Record<string, unknown>): Promise<unknown> {
    // Configured model id always wins — body must not override it (CLA-21).
    const payload = { ...body, model: this.modelId };
    const response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`llm gateway ${response.status}: ${redactLlmSecret(text, this.#apiKey)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("llm gateway returned non-JSON");
    }
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
  const modelNote = isUsableModelId(config.modelId)
    ? `model ${config.modelId}`
    : "empty model id (enrichment pass will fail; atlas still publishes)";
  if (mode === "force") {
    return `forced (OKIE_SCAN_ENRICH=1) gateway ${config.baseUrl} ${modelNote}`;
  }
  if (!hasLlmCredentials(config)) {
    return `auto (no key; enrichment skipped) gateway ${config.baseUrl} ${modelNote}`;
  }
  if (config.keySource === "anthropic-fallback") {
    return `auto (ANTHROPIC_* fallback) gateway ${config.baseUrl} ${modelNote}`;
  }
  return `auto gateway ${config.baseUrl} ${modelNote}`;
}
