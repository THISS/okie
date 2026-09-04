import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOSTED_ASK_AUTH_ERROR,
  MAX_ASK_PACKETS,
  answerAskQuestion,
  askChatCompletionsBody,
  askGatewayConnected,
  askUserMessage,
  parseAskCompletion,
  publicAskStatus,
  sanitizeAskPackets,
} from "./ask.js";
import { createAskThreadStore } from "./askThreads.js";
import { createGithubAuthService, SESSION_COOKIE, TEST_LOGIN_PATH } from "./githubOAuth.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { createLlmGatewayClient, resolveLlmGatewayConfig } from "./llmGateway.js";
import { healthzBody as healthz } from "./localDefaults.js";
import { createScanHttpHandler } from "./scanServer.js";

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

test("Ask keeps observed cyclomatic on packets and derives the >6 flag", () => {
  const kept = sanitizeAskPackets([
    {
      id: "code:simple",
      name: "simple",
      kind: "code",
      cyclomaticComplexity: 1,
      cyclomaticFlagged: true,
      apiKey: FAKE_GATEWAY_KEY,
    },
    {
      id: "code:tangled",
      name: "tangled",
      kind: "code",
      cyclomaticComplexity: 7,
      cyclomaticFlagged: false,
    },
    {
      id: "component:web-shell",
      name: "Application shell",
      kind: "component",
    },
  ]);
  assert.deepEqual(kept.find(packet => packet.id === "code:simple"), {
    id: "code:simple",
    name: "simple",
    kind: "code",
    cyclomaticComplexity: 1,
    cyclomaticFlagged: false,
  });
  assert.deepEqual(kept.find(packet => packet.id === "code:tangled"), {
    id: "code:tangled",
    name: "tangled",
    kind: "code",
    cyclomaticComplexity: 7,
    cyclomaticFlagged: true,
  });
  assert.equal(kept.find(packet => packet.id === "component:web-shell")?.cyclomaticComplexity, undefined);
  const body = askChatCompletionsBody("acme/fast", "Which functions are over 6?", kept, []);
  const user = (body.messages as Array<{ content: string }>)[1]!.content;
  assert.match(user, /"cyclomaticComplexity": 7/);
  assert.match(user, /"cyclomaticFlagged": true/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(FAKE_GATEWAY_KEY));
  assert.equal("apiKey" in (kept[0] as object), false);
});

test("Ask keeps observed clone duplicates on packets", () => {
  const kept = sanitizeAskPackets([
    {
      id: "code:alpha",
      name: "alpha",
      kind: "code",
      duplicates: [
        { id: "code:beta", name: "beta" },
        { id: "code:beta", name: "again" },
        { id: "code:alpha", name: "self" },
        { id: "", name: "ghost" },
      ],
      apiKey: FAKE_GATEWAY_KEY,
    },
    {
      id: "component:web-shell",
      name: "Application shell",
      kind: "component",
    },
  ]);
  assert.deepEqual(kept.find(packet => packet.id === "code:alpha")?.duplicates, [
    { id: "code:beta", name: "beta" },
  ]);
  assert.equal(kept.find(packet => packet.id === "component:web-shell")?.duplicates, undefined);
  const body = askChatCompletionsBody("acme/fast", "Which functions are clones?", kept, [
    { id: "relation:dup:alpha-beta", from: "code:alpha", to: "code:beta", label: "duplicates" },
  ]);
  const user = (body.messages as Array<{ content: string }>)[1]!.content;
  assert.match(user, /"duplicates"/);
  assert.match(user, /"label": "duplicates"/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(FAKE_GATEWAY_KEY));
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
  assert.match(server, /sessionFromRequest\(request\)/);
  assert.match(server, /HOSTED_ASK_AUTH_ERROR/);
  assert.match(server, /persistAskTurn/);
  assert.match(server, /answerAskQuestion\(llm,/);
  assert.match(server, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.doesNotMatch(server, /healthzBody\([^)]*apiKey/);
  assert.doesNotMatch(server, /healthzBody\([^)]*ask/);
  assert.doesNotMatch(main, /healthzBody\([^)]*apiKey/);
});

function cookieFromSetCookie(setCookie: string[], name: string): string | undefined {
  for (const header of setCookie) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0]!.slice(`${name}=`.length);
  }
  return undefined;
}

test("POST /api/ask is 401 without a session and never calls the gateway", async () => {
  let hits = 0;
  const fake = await listenFakeGateway((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(completion(JSON.stringify({ answer: "must not run", citations: [] })));
  });
  const scanRoot = fileURLToPath(new URL(".", import.meta.url));
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: { OKIE_GITHUB_TEST_DOUBLE: "0", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
  });
  const handler = createScanHttpHandler({
    queue: createScanJobQueue(async () => {}),
    allowSubmit: createSubmitLimiter(),
    auth,
    scanRoot,
    llm: resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
      OPENROUTER_MODEL: "acme/fast",
    }),
    enrich: "off",
    bind: "127.0.0.1",
    threads: createAskThreadStore(),
  });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${origin}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_GATEWAY_KEY}` },
      body: JSON.stringify({
        question: "What is Okie?",
        packets,
        atlas: { owner: "THISS", repo: "okie", commitSha: "abc123" },
      }),
    });
    assert.equal(denied.status, 401);
    const body = await denied.json() as { error: string; auth: { required: boolean; loginPath: string }; connected?: unknown };
    assert.equal(body.error, HOSTED_ASK_AUTH_ERROR);
    assert.equal(body.auth.required, true);
    assert.equal(body.auth.loginPath, "/api/auth/github");
    assert.equal("connected" in body, false);
    assert.equal(JSON.stringify(body).includes(FAKE_GATEWAY_KEY), false);
    assert.equal(hits, 0);

    const threadDenied = await fetch(`${origin}/api/ask/thread?owner=THISS&repo=okie&commitSha=abc123`);
    assert.equal(threadDenied.status, 401);

    const status = await fetch(`${origin}/api/ask`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { connected: true });

    const health = await fetch(`${origin}/healthz`);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(healthBody).sort(), ["bind", "enrich", "ok", "public", "service"]);
    assert.equal(JSON.stringify(healthBody).includes(FAKE_GATEWAY_KEY), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fake.close();
  }
});

test("loopback test-login can Ask and reload the same user's thread for owner/repo + commitSha", async () => {
  const fake = await listenFakeGateway((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(completion(JSON.stringify({
      answer: `The web app hosts Ask Atlas. key=${FAKE_GATEWAY_KEY}`,
      citations: ["container:web-app"],
    })));
  });
  const scanRoot = fileURLToPath(new URL(".", import.meta.url));
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: { OKIE_GITHUB_TEST_DOUBLE: "1", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
  });
  const handler = createScanHttpHandler({
    queue: createScanJobQueue(async () => {}),
    allowSubmit: createSubmitLimiter(),
    auth,
    scanRoot,
    llm: resolveLlmGatewayConfig({
      OPENAI_BASE_URL: fake.baseUrl,
      OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
      OPENROUTER_MODEL: "acme/fast",
    }),
    enrich: "off",
    bind: "127.0.0.1",
    threads: createAskThreadStore(),
  });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${origin}${TEST_LOGIN_PATH}`, { redirect: "manual" });
    const session = cookieFromSetCookie(login.headers.getSetCookie(), SESSION_COOKIE);
    assert.ok(session);
    const cookie = `${SESSION_COOKIE}=${session}`;
    const atlas = { owner: "THISS", repo: "okie", commitSha: "abc123def456" };

    const posted = await fetch(`${origin}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ question: "What does the web app do?", packets, atlas }),
    });
    assert.equal(posted.status, 200);
    const body = await posted.json() as {
      connected: boolean;
      answer?: string;
      thread?: { owner: string; repo: string; commitSha: string; turns: Array<{ question: string; answer: string }> };
      apiKey?: unknown;
    };
    assert.equal(body.connected, true);
    assert.match(body.answer ?? "", /web app hosts Ask Atlas/);
    assert.doesNotMatch(body.answer ?? "", new RegExp(FAKE_GATEWAY_KEY));
    assert.equal("apiKey" in body, false);
    assert.equal(body.thread?.owner, "THISS");
    assert.equal(body.thread?.repo, "okie");
    assert.equal(body.thread?.commitSha, atlas.commitSha);
    assert.equal(body.thread?.turns.length, 1);
    const json = JSON.stringify(body);
    assert.equal(json.includes(FAKE_GATEWAY_KEY), false);
    assert.equal(json.includes("gho_"), false);

    const reloaded = await fetch(
      `${origin}/api/ask/thread?owner=THISS&repo=okie&commitSha=${atlas.commitSha}`,
      { headers: { cookie } },
    );
    assert.equal(reloaded.status, 200);
    const threadBody = await reloaded.json() as { thread: { turns: Array<{ question: string; answer: string }>; userId?: unknown } };
    assert.equal(threadBody.thread.turns.length, 1);
    assert.equal(threadBody.thread.turns[0]?.question, "What does the web app do?");
    assert.equal("userId" in threadBody.thread, false);
    assert.equal(JSON.stringify(threadBody).includes(FAKE_GATEWAY_KEY), false);

    const otherMap = await fetch(
      `${origin}/api/ask/thread?owner=THISS&repo=okie&commitSha=othercommit`,
      { headers: { cookie } },
    );
    const otherBody = await otherMap.json() as { thread: { turns: unknown[] } };
    assert.deepEqual(otherBody.thread.turns, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fake.close();
  }
});
