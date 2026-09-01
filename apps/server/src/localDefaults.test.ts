import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_LISTEN_HOST, healthzBody, resolveListenHost } from "./localDefaults.js";
import { publicLlmGatewayView, resolveLlmGatewayConfig } from "./llmGateway.js";

test("listen host defaults to loopback, not all interfaces", () => {
  assert.equal(DEFAULT_LISTEN_HOST, "127.0.0.1");
  assert.equal(resolveListenHost({}), "127.0.0.1");
  assert.equal(resolveListenHost({ OKIE_SERVER_HOST: "  " }), "127.0.0.1");
  assert.notEqual(resolveListenHost({}), "0.0.0.0");
});

test("OKIE_SERVER_HOST is an explicit operator override, not the published default", () => {
  assert.equal(resolveListenHost({ OKIE_SERVER_HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveListenHost({ OKIE_SERVER_HOST: " localhost " }), "localhost");
});

test("healthz reports service status without scanRoot or filesystem paths", () => {
  const body = healthzBody({ enrich: "auto", bind: "127.0.0.1" });
  const json = JSON.stringify(body);

  assert.equal(body.service, "okie-scan-server");
  assert.equal(body.ok, true);
  assert.equal(body.public, false);
  assert.equal(body.bind, "127.0.0.1");
  assert.equal(body.enrich, "auto");
  assert.deepEqual(Object.keys(body).sort(), ["bind", "enrich", "ok", "public", "service"]);

  assert.equal("scanRoot" in body, false);
  assert.equal("modelId" in body, false);
  assert.equal("apiKey" in body, false);
  assert.doesNotMatch(json, /scanRoot/);
  assert.doesNotMatch(json, /modelId/);
  assert.doesNotMatch(json, /apiKey/);
  assert.doesNotMatch(json, /"\/[^"]+"/);
  assert.doesNotMatch(json, /[A-Za-z]:\\/);
});

test("main.ts serves healthzBody on loopback and never puts scanRoot on the wire", () => {
  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/main.ts"), "utf8");
  assert.match(src, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.match(src, /server\.listen\(port,\s*bind/);
  assert.doesNotMatch(src, /sendJson\([^;]*scanRoot/);
});

test("healthz and main.ts never put an LLM API key on the wire", () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const config = resolveLlmGatewayConfig({ OPENROUTER_API_KEY: fakeKey });
  const body = healthzBody({ enrich: "auto", bind: "127.0.0.1" });
  const json = JSON.stringify(body);
  const view = JSON.stringify(publicLlmGatewayView(config));

  assert.doesNotMatch(json, new RegExp(fakeKey));
  assert.doesNotMatch(view, new RegExp(fakeKey));
  assert.equal("apiKey" in body, false);

  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/main.ts"), "utf8");
  assert.match(src, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.doesNotMatch(src, /healthzBody\([^)]*apiKey/);
  assert.doesNotMatch(src, /healthzBody\([^)]*llm/);
  assert.match(src, /describeEnrichmentMode\(enrich,\s*llm\)/);
  assert.match(src, /toPublicJob\(job,\s*text => redactGatewayText\(text,\s*llm\.apiKey\)\)/);
});

test("main.ts wires the hosted GitHub access seam and never the operator gh client", () => {
  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/main.ts"), "utf8");
  assert.match(src, /resolveScanGithubAccess\(request\.headers\)/);
  assert.match(src, /githubClientForAccess\(resolveScanGithubAccess\(\)\)/);
  assert.doesNotMatch(src, /createDefaultGithubClient/);
  assert.doesNotMatch(src, /GITHUB_TOKEN|GH_TOKEN/);
});
