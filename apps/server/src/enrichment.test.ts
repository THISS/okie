import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedPackets, EnrichmentPacket, SystemPacket } from "@okie/scan";
import { createEnricher, enrichmentStreamParams, MAX_ENRICHABLE_CODE_ENTITIES, resolveEnrichmentPassModelId } from "./enrichment.js";

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

test("enricher requests one doc per container plus the system scope, threading the system id", async () => {
  const calls: Array<{ id: string; kind: string; systemId: string }> = [];
  const enrich = createEnricher({
    generate: async (packet, kind, systemId) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      calls.push({ id, kind, systemId });
      return { doc: id };
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
      return { ok: true };
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
    generate: async () => ({ ok: true }),
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
  const enrich = createEnricher({ generate: async () => { called += 1; return {}; } });
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
    generate: async () => ({ ok: true }),
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
    generate: async () => ({ ok: true }),
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
