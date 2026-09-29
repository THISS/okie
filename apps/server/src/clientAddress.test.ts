import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { clientAddressKey, exemptFromIpWindow, parseIpLiteral, resolveClientAddress, resolveTrustedProxy } from "./clientAddress.js";
import { createScanJobQueue } from "./jobs.js";
import { resolveLlmGatewayConfig } from "./llmGateway.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { createPublicReadonlyHttpHandler, createScanHttpHandler, type ScanHttpHandler } from "./scanServer.js";

const request = (remoteAddress: string, headers: Record<string, string | string[]> = {}) => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

test("CLA-266 trusted proxy: only OKIE_TRUSTED_PROXY=cloudflare enables it", () => {
  assert.equal(resolveTrustedProxy({}), undefined);
  assert.equal(resolveTrustedProxy({ OKIE_TRUSTED_PROXY: "" }), undefined);
  assert.equal(resolveTrustedProxy({ OKIE_TRUSTED_PROXY: "1" }), undefined);
  assert.equal(resolveTrustedProxy({ OKIE_TRUSTED_PROXY: "x-forwarded-for" }), undefined);
  assert.equal(resolveTrustedProxy({ OKIE_TRUSTED_PROXY: " Cloudflare " }), "cloudflare");
});

test("CLA-266 trusted proxy: CF-Connecting-IP ignored without the flag, honoured with it, invalid values fall back; XFF never", () => {
  const headers = { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.99" };
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", headers), undefined), { address: "10.0.0.1", fromProxy: false });
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", headers), "cloudflare"), { address: "198.51.100.7", fromProxy: true });
  assert.equal(clientAddressKey(request("10.0.0.1", { "cf-connecting-ip": "2001:db8:1:2::5" }), "cloudflare"), "2001:db8:1:2::/64", "clientIpKey normalisation still applies");
  assert.equal(clientAddressKey(request("10.0.0.1", { "cf-connecting-ip": "::ffff:198.51.100.8" }), "cloudflare"), "198.51.100.8");
  for (const invalid of ["", "not-an-ip", "198.51.100.7, 10.0.0.2", "198.51.100.7:443", "[2001:db8::1]", "fe80::1%eth0", "999.1.1.1"]) {
    assert.deepEqual(resolveClientAddress(request("10.0.0.1", { "cf-connecting-ip": invalid }), "cloudflare"), { address: "10.0.0.1", fromProxy: false }, invalid);
  }
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", { "cf-connecting-ip": ["198.51.100.7", "198.51.100.8"] }), "cloudflare"), { address: "10.0.0.1", fromProxy: false }, "a repeated header is ambiguous");
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", { "x-forwarded-for": "203.0.113.99" }), "cloudflare"), { address: "10.0.0.1", fromProxy: false });
  assert.equal(parseIpLiteral(" 198.51.100.7"), undefined, "callers trim; the parser takes literals only");
});

test("CLA-266 trusted proxy: the Worker's x-okie-client-ip backs up a dropped CF-Connecting-IP, then the socket", () => {
  const edge = { "x-okie-client-ip": "203.0.113.44" };
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", edge), "cloudflare"), { address: "203.0.113.44", fromProxy: true }, "CF-Connecting-IP dropped on the hop");
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", { ...edge, "cf-connecting-ip": "198.51.100.7" }), "cloudflare"), { address: "198.51.100.7", fromProxy: true }, "CF-Connecting-IP wins when present");
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", { ...edge, "cf-connecting-ip": "garbage" }), "cloudflare"), { address: "203.0.113.44", fromProxy: true }, "an invalid CF value falls through to the edge header");
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", edge), undefined), { address: "10.0.0.1", fromProxy: false }, "never trusted without the flag");
  for (const invalid of ["not-an-ip", "203.0.113.44, 10.0.0.2", "fe80::1%eth0"]) {
    assert.deepEqual(resolveClientAddress(request("10.0.0.1", { "x-okie-client-ip": invalid }), "cloudflare"), { address: "10.0.0.1", fromProxy: false }, invalid);
  }
  assert.deepEqual(resolveClientAddress(request("10.0.0.1", { "x-okie-client-ip": ["203.0.113.44", "203.0.113.45"] }), "cloudflare"), { address: "10.0.0.1", fromProxy: false }, "a repeated header is ambiguous");
  assert.equal(clientAddressKey(request("127.0.0.1", edge), "cloudflare"), "203.0.113.44");
});

test("CLA-266 trusted proxy: the loopback exemption applies only without a trusted proxy", () => {
  assert.equal(exemptFromIpWindow(request("127.0.0.1"), undefined), true);
  assert.equal(exemptFromIpWindow(request("::ffff:127.0.0.1"), undefined), true);
  assert.equal(exemptFromIpWindow(request("203.0.113.1"), undefined), false);
  assert.equal(exemptFromIpWindow(request("127.0.0.1"), "cloudflare"), false);
  assert.equal(exemptFromIpWindow(request("127.0.0.1", { "cf-connecting-ip": "198.51.100.7" }), "cloudflare"), false);
});

/** Drives a handler directly with a fake socket address and headers (no HTTP). */
function call(handler: ScanHttpHandler, input: { method?: string; url: string; remoteAddress: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const req = Object.assign(Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)]), {
    method: input.method ?? "POST", url: input.url, headers: { "content-type": "application/json", ...(input.headers ?? {}) }, socket: { remoteAddress: input.remoteAddress },
  });
  return new Promise(resolve => {
    let status = 0;
    const response = { writeHead: (code: number) => { status = code; return response; }, end: (text: string) => resolve({ status, body: text }) };
    void handler(req as never, response as never);
  });
}

const askBody = JSON.stringify({ question: "Where?", packets: [{ id: "container:web", name: "Web", kind: "container" }], atlas: { owner: "acme", repo: "demo", commitSha: "0123456789abcdef0123456789abcdef01234567" } });
const fakeAuth = { handle: async () => false, sessionFromRequest: (req: { headers: Record<string, string> }) => req.headers["x-user"] ? { userId: req.headers["x-user"] } : undefined };

test("CLA-266 trusted proxy: Ask and block-plan per-IP keys use the resolver in both server modes", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-trusted-proxy-"));
  try {
    const ipKeys: string[] = []; const planIps: string[] = [];
    const blockPlans = { config: { enabled: true }, admit: (ip: string, account?: string) => { planIps.push(`${ip}|${account ?? "-"}`); return { status: 200, body: { state: "unavailable", reason: "rate-limited" } }; } };
    const common = { scanRoot, llm: resolveLlmGatewayConfig({}), enrich: "off" as const, bind: "0.0.0.0", allowAskIp: (key: string) => { ipKeys.push(key); return true; }, blockPlans: blockPlans as never };
    const cfHeaders = { "cf-connecting-ip": "198.51.100.7", "x-user": "u1" };
    for (const trustedProxy of [undefined, "cloudflare" as const]) {
      ipKeys.length = 0; planIps.length = 0;
      const handler = createScanHttpHandler({ ...common, queue: createScanJobQueue(async () => {}), allowSubmit: () => false, auth: fakeAuth as never, trustedProxy });
      assert.equal((await call(handler, { url: "/api/ask", remoteAddress: "127.0.0.1", headers: cfHeaders, body: askBody })).status, 200);
      assert.equal((await call(handler, { url: "/api/ask", remoteAddress: "10.1.2.3", headers: cfHeaders, body: askBody })).status, 200);
      await call(handler, { url: "/api/block-plan", remoteAddress: "10.1.2.3", headers: cfHeaders, body: "{}" });
      if (trustedProxy) {
        assert.deepEqual(ipKeys, ["ask-ip:198.51.100.7", "ask-ip:198.51.100.7"], "with the proxy, loopback is no longer exempt and the header is the key");
        assert.deepEqual(planIps, ["198.51.100.7|u1"]);
      } else {
        assert.deepEqual(ipKeys, ["ask-ip:10.1.2.3"], "without the proxy: loopback exempt, the header ignored");
        assert.deepEqual(planIps, ["10.1.2.3|u1"]);
      }
    }
    // Public-readonly: anonymous, same resolver.
    const store = new OperatorStore(scanRoot);
    const publicHandler = createPublicReadonlyHttpHandler({ ...common, mode: "public-readonly", published: { store, publications: new OperatorPublicationService(store) }, trustedProxy: "cloudflare" });
    ipKeys.length = 0; planIps.length = 0;
    assert.equal((await call(publicHandler, { url: "/api/ask", remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "2001:db8:9:9::1" }, body: askBody })).status, 200);
    await call(publicHandler, { url: "/api/block-plan", remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "2001:db8:9:9::1" }, body: "{}" });
    assert.deepEqual(ipKeys, ["ask-ip:2001:db8:9:9::/64"]);
    assert.deepEqual(planIps, ["2001:db8:9:9::/64|-"]);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 trusted proxy: the scan-submit IP window keys on the resolved client", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-trusted-submit-"));
  try {
    const keys: string[] = [];
    const session = { userId: "u1", login: "u1", token: "gho_okieTestOauthAccessTokenCla266x", source: "oauth" };
    const auth = { handle: async () => false, sessionFromRequest: () => session };
    for (const trustedProxy of [undefined, "cloudflare" as const]) {
      const handler = createScanHttpHandler({ queue: createScanJobQueue(async () => {}), allowSubmit: key => { keys.push(key); return true; }, auth: auth as never, scanRoot, llm: resolveLlmGatewayConfig({}), enrich: "off", bind: "127.0.0.1", trustedProxy });
      await call(handler, { url: "/api/scans", remoteAddress: "10.9.9.9", headers: { "cf-connecting-ip": "198.51.100.44" }, body: JSON.stringify({ url: "https://github.com/lukeed/clsx" }) });
    }
    const ipKeys = keys.filter(key => key.startsWith("ip:"));
    assert.deepEqual(ipKeys, ["ip:10.9.9.9", "ip:198.51.100.44"]);
    // Default-mode submit stays per-account too.
    assert.ok(keys.some(key => !key.startsWith("ip:")));
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});
