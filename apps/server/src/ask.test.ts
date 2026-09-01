import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_ASK_PACKETS,
  answerAskQuestion,
  askChatCompletionsBody,
  askGatewayConnected,
  askUserMessage,
  parseAskCompletion,
  publicAskStatus,
  sanitizeAskPackets,
} from "./ask.js";
import { createLlmGatewayClient, resolveLlmGatewayConfig } from "./llmGateway.js";
import { healthzBody as healthz } from "./localDefaults.js";

const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla27-fake";
const PLANTED_SOURCE_SECRET = "gho_okieTestPlantedSecretCla27xxxx";
const OUT_OF_SCOPE_ID = "container:whole-repo-dump";

const packets = [
  {
    id: "container:web-app",
    name: "Web app",
    kind: "container",
    summary: "React shell that hosts Ask Atlas.",
    source: "apps/web/src/App.tsx",
  },
  {
    id: "component:web-shell",
    name: "Application shell",
    kind: "component",
    parentId: "container:web-app",
    summary: "Composes the canvas and Ask popover.",
  },
];

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

function completion(content: string) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

test("without a gateway key Ask reports disconnected and never constructs a client", () => {
  const config = resolveLlmGatewayConfig({});
  assert.equal(askGatewayConnected(config), false);
  assert.deepEqual(publicAskStatus(config), { connected: false });
  assert.equal(createLlmGatewayClient(config), undefined);
  assert.deepEqual(Object.keys(publicAskStatus(config)), ["connected"]);
});

test("ANTHROPIC_* fallback does not count as the OpenAI-compatible Ask gateway", () => {
  const config = resolveLlmGatewayConfig({ ANTHROPIC_API_KEY: "okie-test-anthropic-key-cla27-fake" });
  assert.equal(askGatewayConnected(config), false);
  assert.deepEqual(publicAskStatus(config), { connected: false });
});

test("disconnected Ask returns immediately without calling the gateway", async () => {
  let hits = 0;
  const started = Date.now();
  const result = await answerAskQuestion(
    resolveLlmGatewayConfig({}),
    { question: "What is Okie?", packets },
    {
      gateway: {
        modelId: "acme/fast",
        chatCompletions: async () => {
          hits += 1;
          throw new Error("gateway must not be called");
        },
      },
    },
  );
  assert.deepEqual(result, { connected: false });
  assert.equal(hits, 0);
  assert.ok(Date.now() - started < 200, "disconnected Ask must not wait on a gateway");
});

test("Ask posts only the supplied packets and drops out-of-scope citations", async () => {
  const posted: Record<string, unknown>[] = [];
  const result = await answerAskQuestion(
    resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "acme/fast" }),
    { question: "What does the web app do?", packets },
    {
      gateway: {
        modelId: "acme/fast",
        chatCompletions: async body => {
          posted.push(body);
          return {
            json: JSON.parse(completion(JSON.stringify({
              answer: "The web app hosts Ask Atlas in the React shell.",
              citations: ["container:web-app", OUT_OF_SCOPE_ID, "component:web-shell"],
            }))),
          };
        },
      },
    },
  );
  assert.equal(result.connected, true);
  if (!result.connected || !("answer" in result)) throw new Error("expected an answer");
  assert.match(result.answer, /web app hosts Ask Atlas/);
  assert.deepEqual(result.citations, ["container:web-app", "component:web-shell"]);
  assert.equal(result.citations.includes(OUT_OF_SCOPE_ID), false);
  assert.deepEqual(result.scopeIds, ["container:web-app", "component:web-shell"]);

  const serialized = JSON.stringify(posted[0]);
  assert.match(serialized, /container:web-app/);
  assert.doesNotMatch(serialized, new RegExp(OUT_OF_SCOPE_ID));
  assert.doesNotMatch(serialized, new RegExp(FAKE_GATEWAY_KEY));
  assert.match(serialized, /ONLY the packets and accepted summaries/);
});

test("Ask never silently posts a whole-repo dump of extra packets", () => {
  const extra = Array.from({ length: MAX_ASK_PACKETS + 8 }, (_, index) => ({
    id: index === MAX_ASK_PACKETS ? OUT_OF_SCOPE_ID : `container:scope-${index}`,
    name: `Scope ${index}`,
    kind: "container",
    summary: `Summary ${index}`,
  }));
  const kept = sanitizeAskPackets(extra);
  assert.equal(kept.length, MAX_ASK_PACKETS);
  assert.equal(kept.some(packet => packet.id === OUT_OF_SCOPE_ID), false);
  const message = askUserMessage("What is this repo?", kept, []);
  assert.doesNotMatch(message, new RegExp(OUT_OF_SCOPE_ID));
});

test("Ask strips planted GitHub tokens from packet summaries before the gateway body", () => {
  const dirty = sanitizeAskPackets([{
    id: "container:web-app",
    name: "Web app",
    kind: "container",
    summary: `Uses a token ${PLANTED_SOURCE_SECRET} in CI.`,
  }]);
  assert.equal(dirty[0]?.summary?.includes(PLANTED_SOURCE_SECRET), false);
  assert.match(dirty[0]?.summary ?? "", /\[redacted-token\]/);
  const body = askChatCompletionsBody("acme/fast", "What?", dirty, []);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(PLANTED_SOURCE_SECRET));
});

test("empty scopes do not fall back to a whole-repo dump or a gateway call", async () => {
  let hits = 0;
  const result = await answerAskQuestion(
    resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "acme/fast" }),
    { question: "Dump the repo", packets: [] },
    {
      gateway: {
        modelId: "acme/fast",
        chatCompletions: async () => {
          hits += 1;
          return { json: JSON.parse(completion("{}")) };
        },
      },
    },
  );
  assert.deepEqual(result, { connected: true, error: "Ask needs a selected or isolated scope." });
  assert.equal(hits, 0);
});

test("parseAskCompletion keeps only ids from the current packets", () => {
  const parsed = parseAskCompletion(
    JSON.parse(completion(JSON.stringify({
      answer: "Web shell owns Ask.",
      citations: ["component:web-shell", "container:secret-other-repo"],
    }))),
    new Set(["component:web-shell", "container:web-app"]),
  );
  assert.deepEqual(parsed?.citations, ["component:web-shell"]);
});

test("Ask times out against a hung fake HTTP gateway instead of hanging", async () => {
  const fake = await listenFakeGateway(() => {
    // Never respond — the client deadline must win.
  });
  try {
    const config = resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
      OPENROUTER_MODEL: "acme/fast",
    });
    const started = Date.now();
    const result = await answerAskQuestion(config, { question: "What?", packets }, { timeoutMs: 80 });
    assert.equal(result.connected, true);
    if (!("error" in result)) throw new Error("expected a timeout error");
    assert.match(result.error, /timeout after 80ms/);
    assert.doesNotMatch(result.error, new RegExp(FAKE_GATEWAY_KEY));
    assert.ok(Date.now() - started < 2_000, "hung gateway must not stall Ask");
  } finally {
    await fake.close();
  }
});

test("fake HTTP gateway answers and redacts a key echoed in a 401 body", async () => {
  let calls = 0;
  const fake = await listenFakeGateway((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion(JSON.stringify({
        answer: "The shell hosts Ask Atlas.",
        citations: ["container:web-app"],
      })));
      return;
    }
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `unauthorized ${FAKE_GATEWAY_KEY}` }));
  });
  try {
    const config = resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
      OPENROUTER_MODEL: "acme/fast",
    });
    const ok = await answerAskQuestion(config, { question: "What?", packets });
    assert.equal(ok.connected, true);
    if (!ok.connected || !("answer" in ok)) throw new Error("expected an answer");
    assert.match(ok.answer, /shell hosts Ask Atlas/);

    const failed = await answerAskQuestion(config, { question: "What?", packets });
    assert.equal(failed.connected, true);
    if (!("error" in failed)) throw new Error("expected an error");
    assert.doesNotMatch(failed.error, new RegExp(FAKE_GATEWAY_KEY));
    assert.match(failed.error, /\[redacted-llm-key\]/);
  } finally {
    await fake.close();
  }
});

test("healthz and public Ask status never include the gateway key", () => {
  const config = resolveLlmGatewayConfig({ OPENROUTER_API_KEY: FAKE_GATEWAY_KEY });
  const status = JSON.stringify(publicAskStatus(config));
  const body = JSON.stringify(healthz({ enrich: "auto", bind: "127.0.0.1" }));
  assert.doesNotMatch(status, new RegExp(FAKE_GATEWAY_KEY));
  assert.doesNotMatch(body, new RegExp(FAKE_GATEWAY_KEY));
  assert.equal("apiKey" in publicAskStatus(config), false);
  assert.deepEqual(Object.keys(healthz({ enrich: "auto", bind: "127.0.0.1" })).sort(), [
    "bind",
    "enrich",
    "ok",
    "public",
    "service",
  ]);
});

test("scan HTTP serves Ask on /api/ask and never puts keys on healthz", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const main = readFileSync(join(dir, "../src/main.ts"), "utf8");
  const server = readFileSync(join(dir, "../src/scanServer.ts"), "utf8");
  assert.match(server, /pathname === "\/api\/ask"/);
  assert.match(server, /publicAskStatus\(llm\)/);
  assert.match(server, /answerAskQuestion\(llm,/);
  assert.match(server, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.doesNotMatch(server, /healthzBody\([^)]*apiKey/);
  assert.doesNotMatch(server, /healthzBody\([^)]*ask/);
  assert.doesNotMatch(main, /healthzBody\([^)]*apiKey/);
});
