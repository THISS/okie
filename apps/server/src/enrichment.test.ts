import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildEnrichmentPackets,
  extractArchitecture,
  type EmittedPackets,
  type EnrichmentPacket,
  type SystemPacket,
} from "@okie/scan";
import {
  createEnricher,
  enrichmentChatCompletionsBody,
  enrichmentStreamParams,
  MAX_ENRICHABLE_CODE_ENTITIES,
  packetUserMessage,
  parseChatCompletionDocument,
  resolveEnrichmentPassModelId,
} from "./enrichment.js";
import { createLlmGatewayClient, LlmGatewayError, resolveLlmGatewayConfig } from "./llmGateway.js";
import { createDefaultEnricherFactory } from "./scanService.js";

const containerPacket = (containerId: string, codeCount = 2): EnrichmentPacket => ({
  promptVersion: "okie-enrichment/v2",
  containerId,
  containerName: containerId,
  scopePaths: ["src/a.ts"],
  components: [{ id: `component:${containerId}`, name: "src/a.ts", path: "src/a.ts" }],
  code: Array.from({ length: codeCount }, (_, index) => ({
    id: `code:a-${index}`,
    name: `symbol${index}`,
    path: "src/a.ts",
    componentId: `component:${containerId}`,
  })),
  relations: [],
  excerpts: [],
});

const systemPacket: SystemPacket = {
  promptVersion: "okie-enrichment/v2",
  scope: "system",
  systemId: "system:acme",
  systemName: "Acme",
  scopePaths: ["README.md"],
  containers: [{ id: "container:pkg-a", name: "pkg-a" }],
  externalSystems: [],
  readme: [],
};

const packets = (overrides: Partial<EmittedPackets> = {}): EmittedPackets => ({
  packets: [containerPacket("container:pkg-a")],
  systemPacket,
  manifest: { promptVersion: "okie-enrichment/v2", packets: [] },
  ...overrides,
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

test("enricher requests one doc per container plus the system scope, threading the system id", async () => {
  const calls: Array<{ id: string; kind: string; systemId: string }> = [];
  const enrich = createEnricher({
    generate: async (packet, kind, systemId) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      calls.push({ id, kind, systemId });
      return { document: { doc: id } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "container:pkg-b", "system:acme"]);
  assert.ok(calls.every(call => call.systemId === "system:acme"));
});

test("a per-scope failure omits only that scope and never throws", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      if (kind === "container" && (packet as EnrichmentPacket).containerId === "container:pkg-b") {
        throw new Error("rate limited");
      }
      return { document: { ok: true } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "system:acme"]);
  assert.ok(notes.some(note => note.includes("container:pkg-b") && note.includes("stays deterministic")));
});

test("oversized scopes are skipped with a visible note, not silently", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    generate: async () => ({ document: { ok: true } }),
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:huge", MAX_ENRICHABLE_CODE_ENTITIES + 1)],
  }));
  assert.equal(docs.has("container:huge"), false);
  assert.equal(docs.has("system:acme"), true);
  assert.ok(notes.some(note => note.includes("container:huge") && note.includes("cap")));
});

test("no system packet means no enrichment at all (no gate anchor)", async () => {
  let called = 0;
  const enrich = createEnricher({ generate: async () => { called += 1; return { document: {} }; } });
  const docs = await enrich({
    packets: [containerPacket("container:pkg-a")],
    manifest: { promptVersion: "okie-enrichment/v2", packets: [] },
  });
  assert.equal(docs.size, 0);
  assert.equal(called, 0);
});

test("gateway progress notes never include the API key", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    gateway: { baseUrl: "https://openrouter.ai/api/v1", modelId: "acme/fast" },
    generate: async () => ({ document: { ok: true } }),
  });
  await enrich(packets());
  assert.ok(notes.some(note => note.includes("llm gateway") && note.includes("acme/fast")));
  assert.ok(notes.every(note => !note.includes(fakeKey)));
});

test("enrichment pass uses the configured model id, not a hardcoded table", () => {
  assert.equal(resolveEnrichmentPassModelId({ modelId: "anthropic/claude-sonnet-4" }), "anthropic/claude-sonnet-4");
  assert.equal(resolveEnrichmentPassModelId({ modelId: "acme/cheap" }), "acme/cheap");
  assert.equal(resolveEnrichmentPassModelId({ gateway: { baseUrl: "https://example.gateway/v1", modelId: "openrouter/foo" } }), "openrouter/foo");
  assert.equal(resolveEnrichmentPassModelId({ modelId: "operator/wins", gateway: { baseUrl: "https://x", modelId: "gateway/loses" } }), "operator/wins");
  assert.equal(resolveEnrichmentPassModelId({ modelId: "  " }), undefined);

  const params = enrichmentStreamParams("acme/cheap", "system", "system:acme", systemPacket);
  assert.equal(params.model, "acme/cheap");
  assert.throws(() => enrichmentStreamParams("  ", "system", "system:acme", systemPacket), /empty model id/);

  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/enrichment.ts"), "utf8");
  assert.doesNotMatch(src, /claude-opus-4-8/);
  assert.doesNotMatch(src, /ENRICHMENT_MODEL/);
});

test("empty model id fails the enrichment pass without producing docs", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    modelId: "",
  });
  await assert.rejects(() => enrich(packets()), /empty model id/);
  assert.equal(notes.length, 0);
});

test("configured model id appears in progress notes when the pass runs", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    modelId: "openai/gpt-4o-mini",
    onProgress: note => notes.push(note),
    generate: async () => ({ document: { ok: true } }),
  });
  await enrich(packets());
  assert.ok(notes.some(note => note.includes("model openai/gpt-4o-mini")));
  assert.ok(notes.every(note => !note.includes("claude-opus-4-8")));
});

test("total failure (e.g. bad credentials) throws instead of reporting empty success", async () => {
  const enrich = createEnricher({
    generate: async () => {
      throw new Error("Could not resolve authentication method.");
    },
  });
  await assert.rejects(
    () => enrich(packets()),
    /all 2 enrichment scope\(s\) failed — first error: Could not resolve authentication method\./,
  );
});

test("scan-level max scopes skips remaining scopes without throwing", async () => {
  const notes: string[] = [];
  const called: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxScopes: 1 },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      return { document: { ok: id } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(called, ["container:pkg-a"]);
  assert.deepEqual([...docs.keys()], ["container:pkg-a"]);
  assert.ok(notes.some(note => note.includes("max scopes") && note.includes("skipping")));
  assert.ok(notes.every(note => !note.includes("okie-test-llm-key")));
});

test("scan-level max tokens skips remaining scopes after usage is reported", async () => {
  const called: string[] = [];
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxTokens: 100 },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      return { document: { ok: id }, usage: { totalTokens: 100 } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(called, ["container:pkg-a"]);
  assert.deepEqual([...docs.keys()], ["container:pkg-a"]);
  assert.ok(notes.some(note => note.includes("max tokens")));
});

test("scan-level max dollars applies only when the gateway reports cost", async () => {
  const withCost: string[] = [];
  const costEnrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxDollars: 0.5 },
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      withCost.push(id);
      return { document: { ok: id }, usage: { totalTokens: 10, costUsd: 0.5 } };
    },
  });
  const costDocs = await costEnrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(withCost, ["container:pkg-a"]);
  assert.deepEqual([...costDocs.keys()], ["container:pkg-a"]);

  const withoutCost: string[] = [];
  const noCostEnrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxDollars: 0.01 },
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      withoutCost.push(id);
      return { document: { ok: id }, usage: { totalTokens: 10 } };
    },
  });
  const noCostDocs = await noCostEnrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(withoutCost.sort(), ["container:pkg-a", "container:pkg-b", "system:acme"]);
  assert.equal(noCostDocs.size, 3);
});

test("a per-request timeout omits that scope and continues the others", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 2,
    budget: { requestTimeoutMs: 40 },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      if (kind === "container" && (packet as EnrichmentPacket).containerId === "container:pkg-a") {
        await new Promise(() => {});
      }
      return { document: { ok: true } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.equal(docs.has("container:pkg-a"), false);
  assert.equal(docs.has("container:pkg-b"), true);
  assert.equal(docs.has("system:acme"), true);
  assert.ok(notes.some(note => note.includes("container:pkg-a") && note.includes("timeout")));
});

test("gateway 429 skips remaining scopes and throws so the job can record enrichment failed", async () => {
  const called: string[] = [];
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      if (id === "container:pkg-b") {
        throw new LlmGatewayError("llm gateway 429: too many requests", { kind: "rate_limit", status: 429 });
      }
      return { document: { ok: id } };
    },
  });
  await assert.rejects(
    () => enrich(packets({
      packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b"), containerPacket("container:pkg-c")],
    })),
    /enrichment failed \(llm gateway 429: too many requests\); remaining scopes skipped/,
  );
  assert.deepEqual(called, ["container:pkg-a", "container:pkg-b"]);
  assert.ok(notes.some(note => note.includes("skipping") && note.includes("remaining")));
});

test("gateway 5xx skips remaining scopes and throws", async () => {
  const called: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      if (id === "container:pkg-a") {
        throw new Error("llm gateway 503: unavailable");
      }
      return { document: { ok: id } };
    },
  });
  await assert.rejects(
    () => enrich(packets({
      packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
    })),
    /remaining scopes skipped/,
  );
  assert.deepEqual(called, ["container:pkg-a"]);
});

test("fake HTTP gateway: 429 skips remaining scopes and redacts the key", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const hits: number[] = [];
  const fake = await listenFakeGateway((request, response) => {
    hits.push(Date.now());
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end("no");
      return;
    }
    if (hits.length === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.02 },
      }));
      return;
    }
    if (hits.length === 2) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `rate limited ${fakeKey}` } }));
      return;
    }
    response.writeHead(500);
    response.end("should not be called");
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: fakeKey,
      OPENROUTER_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const notes: string[] = [];
    const enrich = createEnricher({
      maxConcurrent: 1,
      onProgress: note => notes.push(note),
      generate: async () => {
        const result = await client.chatCompletions({ messages: [{ role: "user", content: "packet" }] });
        return result.usage
          ? { document: result.json, usage: result.usage }
          : { document: result.json };
      },
    });
    await assert.rejects(
      () => enrich(packets({
        packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b"), containerPacket("container:pkg-c")],
      })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /llm gateway 429/);
        assert.match(message, /remaining scopes skipped/);
        assert.doesNotMatch(message, new RegExp(fakeKey));
        return true;
      },
    );
    assert.equal(hits.length, 2, "third scope must not hit the gateway after 429");
    assert.ok(notes.every(note => !note.includes(fakeKey)));
  } finally {
    await fake.close();
  }
});

const GATE_DOC = { schemaVersion: 1, entities: [], relations: [] };

function chatCompletionReply(document: unknown, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(document) } }],
    ...(usage ? { usage } : {}),
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("chat-completions body is the bounded packet, not Anthropic Messages fields", () => {
  const packet = containerPacket("container:pkg-a");
  const body = enrichmentChatCompletionsBody("acme/fast", "container", "system:acme", packet);
  assert.equal(body.model, "acme/fast");
  assert.equal(typeof body.max_tokens, "number");
  assert.equal("thinking" in body, false);
  assert.equal("output_config" in body, false);
  assert.equal("system" in body, false);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, "system");
  assert.match(messages[0]!.content, /architecture curator/);
  assert.equal(messages[1]!.role, "user");
  assert.equal(messages[1]!.content, packetUserMessage("container", "system:acme", packet));
  assert.match(messages[1]!.content, /"containerId": "container:pkg-a"/);
  assert.doesNotMatch(messages[1]!.content, /WHOLE_REPO_SENTINEL/);
  const format = body.response_format as { type: string; json_schema: { name: string } };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.name, "architecture_extraction");
  assert.throws(() => enrichmentChatCompletionsBody("  ", "system", "system:acme", systemPacket), /empty model id/);
});

test("prompts ask for a short summary of this packet's scope only", () => {
  const container = enrichmentChatCompletionsBody("acme/fast", "container", "system:acme", containerPacket("container:pkg-a"));
  const system = enrichmentChatCompletionsBody("acme/fast", "system", "system:acme", systemPacket);
  const containerMessages = container.messages as Array<{ role: string; content: string }>;
  const systemMessages = system.messages as Array<{ role: string; content: string }>;
  assert.match(containerMessages[0]!.content, /short summary of THIS packet's scope only/);
  assert.match(containerMessages[0]!.content, /section summary, not a free-form dump/);
  assert.doesNotMatch(containerMessages[0]!.content, /Propose LOGICAL COMPONENTS that regroup/);
  assert.doesNotMatch(containerMessages[0]!.content, /Restate EVERY code entity/);
  assert.match(containerMessages[1]!.content, /Summarize THIS packet's scope only/);
  assert.match(containerMessages[1]!.content, /"containerId": "container:pkg-a"/);
  assert.doesNotMatch(containerMessages[1]!.content, /WHOLE_REPO_SENTINEL/);
  assert.doesNotMatch(containerMessages[1]!.content, /okie-test-llm-key/);

  assert.match(systemMessages[0]!.content, /short summary of THIS packet's scope only/);
  assert.doesNotMatch(systemMessages[0]!.content, /Propose the TOP-LEVEL ACTORS/);
  assert.match(systemMessages[1]!.content, /Summarize THIS packet's scope only/);
  assert.match(systemMessages[1]!.content, /"systemId": "system:acme"/);
  assert.doesNotMatch(systemMessages[1]!.content, /WHOLE_REPO_SENTINEL/);
});

test("parseChatCompletionDocument reads JSON content the gate already consumes", () => {
  assert.deepEqual(parseChatCompletionDocument(chatCompletionReply(GATE_DOC)), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: [{ type: "text", text: JSON.stringify(GATE_DOC) }] } }],
  }), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: "```json\n" + JSON.stringify(GATE_DOC) + "\n```" } }],
  }), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: GATE_DOC } }],
  }), GATE_DOC);
  assert.throws(() => parseChatCompletionDocument({ choices: [] }), /missing message content/);
  assert.throws(() => parseChatCompletionDocument({
    choices: [{ message: { content: "not-json" } }],
  }), /not JSON/);
});

test("gateway adapter posts each packet to chat/completions and keys docs by container id", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const posted: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const fake = await listenFakeGateway(async (request, response) => {
    const raw = await readRequestBody(request);
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : null;
    posted.push({
      url: request.url ?? "",
      authorization,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    const user = ((posted.at(-1)!.body.messages as Array<{ role: string; content: string }>)
      .find(message => message.role === "user")?.content) ?? "";
    const id = user.includes("container:pkg-b")
      ? "container:pkg-b"
      : user.includes("System packet:")
        ? "system:acme"
        : "container:pkg-a";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(
      { ...GATE_DOC, id },
      { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    )));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: fakeKey,
      OPENROUTER_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const notes: string[] = [];
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
      onProgress: note => notes.push(note),
    });
    const docs = await enrich(packets({
      packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
    }));
    assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "container:pkg-b", "system:acme"]);
    assert.deepEqual(docs.get("container:pkg-a"), { ...GATE_DOC, id: "container:pkg-a" });
    assert.deepEqual(docs.get("container:pkg-b"), { ...GATE_DOC, id: "container:pkg-b" });
    assert.deepEqual(docs.get("system:acme"), { ...GATE_DOC, id: "system:acme" });
    assert.equal(posted.length, 3);
    assert.ok(posted.every(call => call.url === "/v1/chat/completions"));
    assert.ok(posted.every(call => call.authorization === `Bearer ${fakeKey}`));
    assert.ok(posted.every(call => call.body.model === "acme/fast"));
    const firstUser = (posted[0]!.body.messages as Array<{ content: string }>)[1]!.content;
    assert.match(firstUser, /"containerId": "container:pkg-a"/);
    assert.doesNotMatch(firstUser, /container:pkg-b/);
    assert.doesNotMatch(firstUser, /WHOLE_REPO_SENTINEL/);
    const secondUser = (posted[1]!.body.messages as Array<{ content: string }>)[1]!.content;
    assert.match(secondUser, /"containerId": "container:pkg-b"/);
    assert.doesNotMatch(secondUser, /container:pkg-a/);
    assert.ok(posted.every(call => !("thinking" in call.body)));
    assert.ok(notes.some(note => note.includes("llm gateway") && note.includes("acme/fast")));
    assert.ok(notes.every(note => !note.includes(fakeKey)));
  } finally {
    await fake.close();
  }
});

test("default enricher factory drives packets through chatCompletions on a fake gateway", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const posted: string[] = [];
  const fake = await listenFakeGateway(async (request, response) => {
    posted.push(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(GATE_DOC)));
  });
  try {
    const hook = createDefaultEnricherFactory("auto", {
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: fakeKey,
      OPENROUTER_MODEL: "acme/fast",
    })(() => {});
    assert.ok(hook);
    const docs = await hook(packets());
    assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "system:acme"]);
    assert.deepEqual(docs.get("container:pkg-a"), GATE_DOC);
    assert.equal(posted.length, 2);
    const userMessages = posted.map(raw => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      return body.messages.find(message => message.role === "user")?.content ?? "";
    });
    assert.ok(userMessages.some(content => /"containerId": "container:pkg-a"/.test(content)));
    assert.ok(userMessages.some(content => /"systemId": "system:acme"/.test(content)));
    assert.ok(posted.every(body => !body.includes(fakeKey)));
    assert.ok(posted.every(body => !body.includes("WHOLE_REPO_SENTINEL")));
  } finally {
    await fake.close();
  }
});

test("a planted secret in source does not appear in the outbound chatCompletions JSON body", async () => {
  const planted = "gho_okieTestPlantedSecretCla25xxxx";
  const fakeKey = "okie-test-llm-key-cla25-fake";
  const sourceFiles: Record<string, string> = {
    "README.md": `# Acme\n`,
    "src/index.ts": `export const ping = () => "pong";\nconst planted = "${planted}";\n`,
  };
  const read = (path: string): string => {
    const text = sourceFiles[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: {
      sourceFiles: ["src/index.ts"],
      units: [{ kind: "root", dir: "", name: "acme-app", packageName: "acme-app", evidencePath: "package.json" }],
      unitByFile: new Map([["src/index.ts", ""]]),
      unitByPackageName: new Map([["acme-app", ""]]),
      summary: { singlePackage: true, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
    },
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const emitted = buildEnrichmentPackets(extraction, read);
  assert.ok(emitted.packets.length > 0);

  const leakedPacket = containerPacket("container:pkg-a");
  leakedPacket.excerpts = [{
    path: "src/a.ts",
    startLine: 1,
    endLine: 2,
    lines: [`export const ping = () => "pong";`, `const token = "${planted}";`],
  }];

  const posted: string[] = [];
  const fake = await listenFakeGateway(async (request, response) => {
    posted.push(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(GATE_DOC)));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: fakeKey,
      OPENROUTER_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
    });
    await enrich(packets({
      packets: [...emitted.packets, leakedPacket],
      ...(emitted.systemPacket ? { systemPacket: emitted.systemPacket } : {}),
    }));
    assert.ok(posted.length > 0, "gateway must receive at least one chatCompletions POST");
    for (const body of posted) {
      assert.equal(body.includes(planted), false, "planted source secret must not appear in outbound JSON");
      assert.equal(body.includes(fakeKey), false, "operator key must not appear in outbound JSON");
      assert.equal(body.includes("WHOLE_REPO_SENTINEL"), false);
    }
    assert.ok(posted.some(body => body.includes("[redacted-token]")));
    assert.ok(posted.some(body => body.includes("container:pkg-a")));
    const raw = JSON.stringify(leakedPacket);
    assert.equal(raw.includes(planted), true, "fixture packet still contains the planted secret before the gateway path");
  } finally {
    await fake.close();
  }
});
