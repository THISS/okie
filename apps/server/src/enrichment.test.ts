import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedPackets, EnrichmentPacket, SystemPacket } from "@okie/scan";
import { createEnricher, MAX_ENRICHABLE_CODE_ENTITIES } from "./enrichment.js";

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
