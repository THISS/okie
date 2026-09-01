import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  createLlmGatewayClient,
  DEFAULT_GATEWAY_MODEL_ID,
  DEFAULT_OPENROUTER_BASE_URL,
  describeEnrichmentMode,
  hasLlmCredentials,
  publicLlmGatewayView,
  readLlmGatewayLocalConfigFile,
  redactLlmSecret,
  resolveLlmGatewayConfig,
  resolveLlmGatewayLocalConfig,
} from "./llmGateway.js";

/** Distinctive fake — never a real key. Must not appear in healthz/logs/inspect. */
const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla20-fake";
const FAKE_ANTHROPIC_KEY = "okie-test-anthropic-key-cla20-fake";

test("defaults suit OpenRouter: base URL and documented model id", () => {
  const config = resolveLlmGatewayConfig({});
  assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  assert.equal(config.modelId, DEFAULT_GATEWAY_MODEL_ID);
  assert.equal(config.keySource, "none");
  assert.equal("apiKey" in config, false);
  assert.equal(hasLlmCredentials(config), false);
});

test("env maps onto base URL, model id, and gateway key", () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_BASE_URL: " https://example.gateway/v1 ",
    OKIE_LLM_MODEL: " acme/fast ",
    OKIE_LLM_API_KEY: ` ${FAKE_GATEWAY_KEY} `,
  });
  assert.equal(config.baseUrl, "https://example.gateway/v1");
  assert.equal(config.modelId, "acme/fast");
  assert.equal(config.keySource, "gateway");
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
});

test("OPENROUTER_* / OPENAI_* aliases map when OKIE_LLM_* is unset", () => {
  const openrouter = resolveLlmGatewayConfig({
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4",
    OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
  });
  assert.equal(openrouter.keySource, "gateway");
  assert.equal(openrouter.apiKey, FAKE_GATEWAY_KEY);
  assert.equal(openrouter.modelId, "anthropic/claude-sonnet-4");
  assert.equal(openrouter.baseUrl, DEFAULT_OPENROUTER_BASE_URL);

  const openai = resolveLlmGatewayConfig({
    OPENAI_API_KEY: FAKE_GATEWAY_KEY,
    OPENAI_MODEL: "openai/gpt-4o-mini",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  });
  assert.equal(openai.keySource, "gateway");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.modelId, "openai/gpt-4o-mini");
});

test("local config overlay wins for base URL and model id; keys stay env-only", () => {
  const config = resolveLlmGatewayConfig(
    {
      OKIE_LLM_BASE_URL: "https://from-env/v1",
      OKIE_LLM_MODEL: "env/model",
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    },
    { baseUrl: "https://from-local/v1", modelId: "local/model" },
  );
  assert.equal(config.baseUrl, "https://from-local/v1");
  assert.equal(config.modelId, "local/model");
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
  assert.equal(config.keySource, "gateway");
});

test("ANTHROPIC_* remains a fallback when no gateway key is set", () => {
  const config = resolveLlmGatewayConfig({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY });
  assert.equal(config.keySource, "anthropic-fallback");
  assert.equal(config.apiKey, FAKE_ANTHROPIC_KEY);
  assert.equal(config.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  assert.equal(createLlmGatewayClient(config), undefined, "Anthropic keys must not be sent to the OpenAI-compatible gateway");
});

test("gateway key wins over ANTHROPIC_* so Anthropic is not the only provider path", () => {
  const config = resolveLlmGatewayConfig({
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
  });
  assert.equal(config.keySource, "gateway");
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
  const client = createLlmGatewayClient(config);
  assert.ok(client);
  assert.equal(client.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  assert.equal(client.modelId, DEFAULT_GATEWAY_MODEL_ID);
});

test("local config file maps baseUrl/modelId and ignores a misplaced apiKey", () => {
  const dir = mkdtempSync(join(tmpdir(), "okie-llm-local-"));
  try {
    const path = join(dir, "okie.local.json");
    writeFileSync(path, JSON.stringify({
      baseUrl: "https://file-gateway/v1/",
      modelId: "file/model",
      apiKey: FAKE_GATEWAY_KEY,
    }));
    const local = readLlmGatewayLocalConfigFile(path);
    assert.deepEqual(local, { baseUrl: "https://file-gateway/v1/", modelId: "file/model" });
    assert.equal("apiKey" in local, false);

    const resolved = resolveLlmGatewayLocalConfig(dir, {});
    assert.deepEqual(resolved, local);

    const viaEnv = resolveLlmGatewayLocalConfig("/unused", { OKIE_LLM_CONFIG: path });
    assert.deepEqual(viaEnv, local);

    assert.throws(
      () => resolveLlmGatewayLocalConfig(dir, { OKIE_LLM_CONFIG: join(dir, "missing.json") }),
      /OKIE_LLM_CONFIG file not found/,
    );

    const config = resolveLlmGatewayConfig({}, local);
    assert.equal(config.baseUrl, "https://file-gateway/v1/");
    assert.equal(config.modelId, "file/model");
    assert.equal(config.keySource, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public view, inspect, and JSON never contain the key", () => {
  const config = resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY });
  const client = createLlmGatewayClient(config);
  assert.ok(client);

  const viewJson = JSON.stringify(publicLlmGatewayView(config));
  const configJson = JSON.stringify(config);
  const clientJson = JSON.stringify(client);
    const inspectedClient = inspect(client, { showHidden: true });
    const inspectedConfig = inspect(config, { showHidden: true });
  const described = describeEnrichmentMode("auto", config);

  for (const blob of [viewJson, configJson, clientJson, inspectedClient, inspectedConfig, described]) {
    assert.doesNotMatch(blob, new RegExp(FAKE_GATEWAY_KEY));
  }
  assert.match(viewJson, /"keyConfigured":true/);
  assert.doesNotMatch(viewJson, /apiKey/);
  assert.equal(Object.keys(config).includes("apiKey"), false);
  assert.equal(client.hasApiKey, true);
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
});

test("chatCompletions posts to the OpenAI-compatible path and redacts the key on errors", async () => {
  const config = resolveLlmGatewayConfig({
    OPENAI_BASE_URL: "https://example.gateway/v1",
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENROUTER_MODEL: "acme/fast",
  });
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const client = createLlmGatewayClient(config, {
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(`${FAKE_GATEWAY_KEY} leaked in body`, { status: 401 });
    },
  });
  assert.ok(client);

  await assert.rejects(
    () => client.chatCompletions({ messages: [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(FAKE_GATEWAY_KEY));
      assert.match(message, /\[redacted-llm-key\]/);
      assert.match(message, /401/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://example.gateway/v1/chat/completions");
  assert.equal(calls[0]!.authorization, `Bearer ${FAKE_GATEWAY_KEY}`);
  assert.equal((calls[0]!.body as { model: string }).model, "acme/fast");
});

test("redactLlmSecret is a no-op without a secret and never logs the key", () => {
  assert.equal(redactLlmSecret("ok", undefined), "ok");
  assert.equal(redactLlmSecret(`used ${FAKE_GATEWAY_KEY}`, FAKE_GATEWAY_KEY), "used [redacted-llm-key]");
});

test("describeEnrichmentMode never includes the key", () => {
  const none = resolveLlmGatewayConfig({});
  assert.match(describeEnrichmentMode("auto", none), /no key; enrichment skipped/);
  assert.doesNotMatch(describeEnrichmentMode("off", none), /openrouter\.ai/);

  const keyed = resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY });
  const line = describeEnrichmentMode("auto", keyed);
  assert.doesNotMatch(line, new RegExp(FAKE_GATEWAY_KEY));
  assert.match(line, /openrouter\.ai\/api\/v1/);
});
