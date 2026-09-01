import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  classifyLlmGatewayFailure,
  createLlmGatewayClient,
  DEFAULT_GATEWAY_MODEL_ID,
  DEFAULT_MAX_ENRICHMENT_DOLLARS,
  DEFAULT_MAX_ENRICHMENT_SCOPES,
  DEFAULT_MAX_ENRICHMENT_TOKENS,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeEnrichmentMode,
  hasLlmCredentials,
  isUsableModelId,
  LlmGatewayError,
  publicLlmGatewayView,
  readGatewayUsage,
  readLlmGatewayLocalConfigFile,
  redactGatewayText,
  redactLlmSecret,
  requireUsableModelId,
  resolveEnrichmentBudget,
  resolveLlmGatewayConfig,
  resolveLlmGatewayLocalConfig,
  shouldSkipRemainingScopes,
} from "./llmGateway.js";

/** Distinctive fake — never a real key. Must not appear in healthz/logs/inspect. */
const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla20-fake";
const FAKE_ANTHROPIC_KEY = "okie-test-anthropic-key-cla20-fake";
/** Obviously fake GitHub-shaped token for planted-secret tests (existing `gho_` scrub). */
const PLANTED_SOURCE_SECRET = "gho_okieTestPlantedSecretCla25xxxx";

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
      return new Response(`${FAKE_GATEWAY_KEY} leaked ${PLANTED_SOURCE_SECRET} in body`, { status: 401 });
    },
  });
  assert.ok(client);

  await assert.rejects(
    () => client.chatCompletions({ messages: [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(FAKE_GATEWAY_KEY));
      assert.equal(message.includes(PLANTED_SOURCE_SECRET), false);
      assert.match(message, /\[redacted-llm-key\]/);
      assert.match(message, /\[redacted-token\]/);
      assert.match(message, /401/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://example.gateway/v1/chat/completions");
  assert.equal(calls[0]!.authorization, `Bearer ${FAKE_GATEWAY_KEY}`);
  assert.equal((calls[0]!.body as { model: string }).model, "acme/fast");
});

test("chatCompletions scrubs a planted token out of the outbound JSON body", async () => {
  const config = resolveLlmGatewayConfig({
    OPENAI_BASE_URL: "https://example.gateway/v1",
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENROUTER_MODEL: "acme/fast",
  });
  const bodies: string[] = [];
  const client = createLlmGatewayClient(config, {
    fetch: async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.ok(client);
  await client.chatCompletions({
    messages: [{ role: "user", content: `packet ${PLANTED_SOURCE_SECRET} ${FAKE_GATEWAY_KEY}` }],
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.includes(PLANTED_SOURCE_SECRET), false);
  assert.equal(bodies[0]!.includes(FAKE_GATEWAY_KEY), false);
  assert.match(bodies[0]!, /\[redacted-token\]/);
  assert.match(bodies[0]!, /\[redacted-llm-key\]/);
});

test("chatCompletions always sends the configured model id, even if body.model is set", async () => {
  const config = resolveLlmGatewayConfig({
    OPENAI_BASE_URL: "https://example.gateway/v1",
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENROUTER_MODEL: "operator/chosen",
  });
  let posted: unknown;
  const client = createLlmGatewayClient(config, {
    fetch: async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.ok(client);
  await client.chatCompletions({ model: "injected/override", messages: [] });
  assert.equal((posted as { model: string }).model, "operator/chosen");
});

test("present-but-empty model id does not fall back to the documented default", () => {
  const fromEnv = resolveLlmGatewayConfig({
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENROUTER_MODEL: "  ",
  });
  assert.equal(fromEnv.modelId, "");
  assert.equal(isUsableModelId(fromEnv.modelId), false);

  const fromLocal = resolveLlmGatewayConfig(
    { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY },
    { modelId: "" },
  );
  assert.equal(fromLocal.modelId, "");
  assert.throws(() => requireUsableModelId(fromLocal.modelId), /empty model id/);

  const unset = resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY });
  assert.equal(unset.modelId, DEFAULT_GATEWAY_MODEL_ID);
  assert.equal(isUsableModelId(unset.modelId), true);
});

test("empty modelId in local config file is preserved as empty, not dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "okie-llm-empty-model-"));
  try {
    const path = join(dir, "okie.local.json");
    writeFileSync(path, JSON.stringify({ modelId: "   " }));
    const local = readLlmGatewayLocalConfigFile(path);
    assert.equal(local.modelId, "");
    const config = resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY }, local);
    assert.equal(config.modelId, "");
    assert.match(describeEnrichmentMode("auto", config), /empty model id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactLlmSecret is a no-op without a secret and never logs the key", () => {
  assert.equal(redactLlmSecret("ok", undefined), "ok");
  assert.equal(redactLlmSecret(`used ${FAKE_GATEWAY_KEY}`, FAKE_GATEWAY_KEY), "used [redacted-llm-key]");
});

test("redactGatewayText applies the existing GitHub token scrub and the operator key", () => {
  const mixed = `quota ${PLANTED_SOURCE_SECRET} key ${FAKE_GATEWAY_KEY}`;
  const redacted = redactGatewayText(mixed, FAKE_GATEWAY_KEY);
  assert.equal(redacted.includes(PLANTED_SOURCE_SECRET), false);
  assert.equal(redacted.includes(FAKE_GATEWAY_KEY), false);
  assert.match(redacted, /\[redacted-token\]/);
  assert.match(redacted, /\[redacted-llm-key\]/);
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

test("resolveEnrichmentBudget reads env and keeps documented defaults", () => {
  assert.deepEqual(resolveEnrichmentBudget({}), {
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxScopes: DEFAULT_MAX_ENRICHMENT_SCOPES,
    maxTokens: DEFAULT_MAX_ENRICHMENT_TOKENS,
    maxDollars: DEFAULT_MAX_ENRICHMENT_DOLLARS,
  });
  const custom = resolveEnrichmentBudget({
    OKIE_LLM_TIMEOUT_MS: "1500",
    OKIE_LLM_MAX_SCOPES: "3",
    OKIE_LLM_MAX_TOKENS: "9000",
    OKIE_LLM_MAX_DOLLARS: "0.25",
  });
  assert.deepEqual(custom, {
    requestTimeoutMs: 1500,
    maxScopes: 3,
    maxTokens: 9000,
    maxDollars: 0.25,
  });
  const invalid = resolveEnrichmentBudget({
    OKIE_LLM_TIMEOUT_MS: "nope",
    OKIE_LLM_MAX_SCOPES: "0",
    OKIE_LLM_MAX_TOKENS: "-4",
    OKIE_LLM_MAX_DOLLARS: "",
  });
  assert.deepEqual(invalid, resolveEnrichmentBudget({}));
});

test("readGatewayUsage parses OpenAI tokens and OpenRouter cost", () => {
  assert.deepEqual(readGatewayUsage({
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.02 },
  }), { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.02 });
  assert.deepEqual(readGatewayUsage({ usage: { input_tokens: 3, output_tokens: 4 } }), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
  });
  assert.deepEqual(readGatewayUsage({}, 1.5), { totalTokens: 0, costUsd: 1.5 });
  assert.equal(readGatewayUsage({ choices: [] }), undefined);
});

test("429 and 5xx abort remaining scopes; 4xx and timeout do not", () => {
  assert.equal(shouldSkipRemainingScopes(new LlmGatewayError("llm gateway 429: x", { kind: "rate_limit", status: 429 })), true);
  assert.equal(shouldSkipRemainingScopes(new Error("llm gateway 503: unavailable")), true);
  assert.equal(shouldSkipRemainingScopes(new Error("llm gateway 400: bad model")), false);
  assert.equal(classifyLlmGatewayFailure(new LlmGatewayError("timeout", { kind: "timeout" })), "timeout");
  assert.equal(shouldSkipRemainingScopes(new LlmGatewayError("timeout", { kind: "timeout" })), false);
});

async function listenFakeGateway(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake gateway has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => { if (error) reject(error); else resolve(); });
    }),
  };
}

test("chatCompletions times out against a hung fake HTTP gateway", async () => {
  const fake = await listenFakeGateway(() => {
    // Never respond — the client deadline must win.
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
      OPENROUTER_MODEL: "acme/fast",
    }), { timeoutMs: 80 });
    assert.ok(client);
    await assert.rejects(
      () => client.chatCompletions({ messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmGatewayError);
        assert.equal(error.kind, "timeout");
        assert.match(error.message, /timeout after 80ms/);
        assert.doesNotMatch(error.message, new RegExp(FAKE_GATEWAY_KEY));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("chatCompletions parses usage from a fake HTTP gateway and redacts 429 bodies", async () => {
  let calls = 0;
  const fake = await listenFakeGateway((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-openrouter-cost": "0.004",
      });
      response.end(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }));
      return;
    }
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `quota ${FAKE_GATEWAY_KEY}` }));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
      OPENROUTER_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const ok = await client.chatCompletions({ messages: [] });
    assert.deepEqual(ok.usage, { promptTokens: 8, completionTokens: 2, totalTokens: 10, costUsd: 0.004 });
    await assert.rejects(
      () => client.chatCompletions({ messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmGatewayError);
        assert.equal(error.kind, "rate_limit");
        assert.equal(error.status, 429);
        assert.doesNotMatch(error.message, new RegExp(FAKE_GATEWAY_KEY));
        assert.match(error.message, /\[redacted-llm-key\]/);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("chatCompletions maps 5xx from a fake HTTP gateway", async () => {
  const fake = await listenFakeGateway((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(`upstream ${FAKE_GATEWAY_KEY}`);
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    await assert.rejects(
      () => client.chatCompletions({ messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmGatewayError);
        assert.equal(error.kind, "server");
        assert.equal(error.status, 503);
        assert.equal(shouldSkipRemainingScopes(error), true);
        assert.doesNotMatch(error.message, new RegExp(FAKE_GATEWAY_KEY));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});
