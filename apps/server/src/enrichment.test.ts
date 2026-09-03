import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildEnrichmentPackets,
  extractArchitecture,
  MAX_COMPONENTS_PER_PACKET,
  mergeEnrichment,
  type Discovery,
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
  coerceGatewayExtractionDocument,
  resolveEnrichmentPassModelId,
} from "./enrichment.js";
import {
  createGlobalEnrichmentSpend,
  clampEnrichmentBudget,
} from "./globalSpend.js";
import { createLlmGatewayClient, LlmGatewayError, resolveEnrichmentBudget, resolveLlmGatewayConfig } from "./llmGateway.js";
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

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

type ExtractionDoc = { schemaVersion: number; entities: Array<{ id: string; kind: string }>; relations: unknown[] };

function asDocArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "remainder packets must group onto one container id");
  return value;
}

function componentEntities(doc: unknown): Array<{ id: string; kind: string }> {
  const record = doc && typeof doc === "object" ? doc as ExtractionDoc : undefined;
  return (record?.entities ?? []).filter(entity => entity.kind === "component");
}

function loadAppsWebFixture(name: "container__apps-web.json" | "container__apps-web.2.json"): ExtractionDoc {
  return JSON.parse(readFileSync(join(repoRoot, "fixtures/enrichment/thiss-okie", name), "utf8")) as ExtractionDoc;
}

function summaryFromPacket(
  packet: EnrichmentPacket,
  systemId: string,
  systemName: string,
  extraEntities: object[] = [],
): ExtractionDoc {
  return {
    schemaVersion: 1,
    entities: [
      { id: systemId, kind: "softwareSystem", name: systemName, sourceRefs: [] },
      {
        id: packet.containerId, kind: "container", parentId: systemId, name: packet.containerName,
        responsibility: `Summary of ${packet.containerName} chunk ${packet.chunkIndex ?? 1}.`,
        sourceRefs: [],
      },
      ...packet.components.map(component => ({
        id: component.id, kind: "component", parentId: packet.containerId, name: component.name,
        responsibility: `Summary of ${component.name}.`, sourceRefs: [],
      })),
      ...extraEntities,
    ] as ExtractionDoc["entities"],
    relations: [],
  };
}

function hugeExtraction(fileCount: number) {
  const sourceFiles: string[] = [];
  const files: Record<string, string> = {
    "README.md": "# Huge",
    "pkg/h/package.json": `${JSON.stringify({ name: "@acme/h" }, null, 2)}\n`,
  };
  const unitByFile = new Map<string, string>();
  for (let index = 0; index < fileCount; index += 1) {
    const path = `pkg/h/src/f${String(index).padStart(3, "0")}.ts`;
    sourceFiles.push(path);
    files[path] = `export function fn${index}() { return ${index}; }\n`;
    unitByFile.set(path, "pkg/h");
  }
  const readHuge = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const discovery: Discovery = {
    sourceFiles,
    units: [{ kind: "member", dir: "pkg/h", name: "@acme/h", packageName: "@acme/h", evidencePath: "pkg/h" }],
    unitByFile,
    unitByPackageName: new Map([["@acme/h", "pkg/h"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  return { extraction: extractArchitecture({ discovery, readFile: readHuge, systemName: "Huge", systemSlug: "huge" }), readHuge };
}

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

test("remainder packets for the same container union; later chunk does not overwrite the first", async () => {
  const first = loadAppsWebFixture("container__apps-web.json");
  const remainder = loadAppsWebFixture("container__apps-web.2.json");
  assert.equal(componentEntities(first).length, 61, "chunk 1 restates 61 @okie/web file-components");
  assert.equal(componentEntities(remainder).length, 7, "remainder restates the leftover 7");

  const enrich = createEnricher({
    maxConcurrent: 2,
    generate: async (packet, kind) => {
      if (kind === "system") return { document: { schemaVersion: 1, entities: [], relations: [] } };
      const scoped = packet as EnrichmentPacket;
      if (scoped.chunkIndex === 1) {
        await new Promise(resolve => { setTimeout(resolve, 40); });
        return { document: first };
      }
      return { document: remainder };
    },
  });
  const docs = await enrich(packets({
    packets: [
      { ...containerPacket("container:apps-web"), chunkIndex: 1, chunkCount: 2 },
      { ...containerPacket("container:apps-web"), chunkIndex: 2, chunkCount: 2 },
    ],
  }));
  const grouped = asDocArray(docs.get("container:apps-web"));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0], first, "packet order, not completion order");
  assert.equal(grouped[1], remainder);
  const unioned = new Set(grouped.flatMap(doc => componentEntities(doc).map(entity => entity.id)));
  assert.equal(unioned.size, 68, "hosted enrichWithPackets must keep 68 @okie/web file-components, not 7");
  assert.notEqual(componentEntities(grouped.at(-1)).length, 68);
  assert.equal(componentEntities(grouped.at(-1)).length, 7, "last-write-wins would have kept only the remainder");
});

test("hosted remainder packets union through the gate: 68 file-components, not 7", async () => {
  const fileCount = MAX_COMPONENTS_PER_PACKET + 7;
  const { extraction, readHuge } = hugeExtraction(fileCount);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const chunks = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.components.length, MAX_COMPONENTS_PER_PACKET);
  assert.equal(chunks[1]!.components.length, 7);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;

  const enrich = createEnricher({
    maxConcurrent: 2,
    generate: async (packet, kind, systemId) => {
      if (kind === "system") {
        return {
          document: {
            schemaVersion: 1,
            entities: [{ id: systemId, kind: "softwareSystem", name: system.name, responsibility: "Huge test system.", sourceRefs: [] }],
            relations: [],
          },
        };
      }
      return { document: summaryFromPacket(packet as EnrichmentPacket, systemId, system.name) };
    },
  });
  const docs = await enrich(emitted);
  const grouped = asDocArray(docs.get("container:pkg-h"));
  assert.equal(componentEntities(grouped.at(-1)).length, 7, "overwrite would keep only the remainder chunk");
  const { extraction: merged, report } = mergeEnrichment(extraction, docs);
  const web = report.results.find(result => result.containerId === "container:pkg-h");
  assert.equal(web?.accepted, true, web?.reasons.join("; "));
  assert.equal(web?.components, fileCount);
  const summarized = merged.entities.filter(entity =>
    entity.kind === "component" && entity.parentId === "container:pkg-h" && entity.responsibility);
  assert.equal(summarized.length, 68, "union must keep 68 file-component summaries, not 7");
});

test("a hallucinated-id remainder rejects that document; the sibling packet still merges", async () => {
  const fileCount = MAX_COMPONENTS_PER_PACKET + 7;
  const { extraction, readHuge } = hugeExtraction(fileCount);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const chunks = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  const firstIds = new Set(chunks[0]!.components.map(component => component.id));
  const remainderIds = new Set(chunks[1]!.components.map(component => component.id));
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;

  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind, systemId) => {
      if (kind === "system") {
        return {
          document: {
            schemaVersion: 1,
            entities: [{ id: systemId, kind: "softwareSystem", name: system.name, responsibility: "Huge test system.", sourceRefs: [] }],
            relations: [],
          },
        };
      }
      const scoped = packet as EnrichmentPacket;
      const extra = scoped.chunkIndex === 2 ? [{
        id: "code:ghost:nope",
        kind: "code",
        parentId: scoped.components[0]!.id,
        name: "nope",
        sourceRefs: [{ path: scoped.scopePaths[0] ?? "pkg/h/src/f000.ts" }],
      }] : [];
      return { document: summaryFromPacket(scoped, systemId, system.name, extra) };
    },
  });
  const docs = await enrich(emitted);
  const grouped = asDocArray(docs.get("container:pkg-h"));
  assert.equal(grouped.length, 2, "the hallucinated remainder is still handed to the gate");
  const { extraction: merged, report } = mergeEnrichment(extraction, docs);
  assert.equal(report.results.find(result => result.containerId === "container:pkg-h")?.accepted, true);
  const summarized = merged.entities.filter(entity =>
    entity.kind === "component" && entity.parentId === "container:pkg-h" && entity.responsibility);
  for (const id of firstIds) {
    assert.equal(merged.entities.find(entity => entity.id === id)?.responsibility, `Summary of ${merged.entities.find(entity => entity.id === id)?.name}.`);
  }
  assert.equal(summarized.length, firstIds.size, "rejected remainder must not drop the accepted sibling");
  for (const id of remainderIds) {
    assert.equal(merged.entities.find(entity => entity.id === id)?.responsibility, undefined);
  }
  assert.ok(!merged.entities.some(entity => entity.id === "code:ghost:nope"));
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

test("gateway progress notes include the model id and never a tokenized URL", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const urlToken = "okie-test-url-token-cla29-fake";
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    gateway: {
      baseUrl: `https://okietest:${urlToken}@example.invalid/v1?api_key=${urlToken}`,
      modelId: "acme/fast",
    },
    generate: async () => ({ document: { ok: true } }),
  });
  await enrich(packets());
  const gatewayNote = notes.find(note => note.includes("llm gateway"));
  assert.ok(gatewayNote);
  assert.match(gatewayNote, /llm gateway example\.invalid model acme\/fast/);
  assert.doesNotMatch(gatewayNote, /https:\/\//);
  assert.ok(notes.every(note => !note.includes(fakeKey)));
  assert.ok(notes.every(note => !note.includes(urlToken)));
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
  assert.match(containerMessages[0]!.content, /"schemaVersion":1/);
  assert.match(containerMessages[0]!.content, /flat array of entity objects/);
  assert.match(containerMessages[0]!.content, /Do not nest softwareSystems, containers, components, or codeEntities/);
  assert.doesNotMatch(containerMessages[0]!.content, /Propose LOGICAL COMPONENTS that regroup/);
  assert.doesNotMatch(containerMessages[0]!.content, /Restate EVERY code entity/);
  assert.match(containerMessages[1]!.content, /Summarize THIS packet's scope only/);
  assert.match(containerMessages[1]!.content, /"containerId": "container:pkg-a"/);
  assert.doesNotMatch(containerMessages[1]!.content, /WHOLE_REPO_SENTINEL/);
  assert.doesNotMatch(containerMessages[1]!.content, /okie-test-llm-key/);

  assert.match(systemMessages[0]!.content, /short summary of THIS packet's scope only/);
  assert.match(systemMessages[0]!.content, /"schemaVersion":1/);
  assert.match(systemMessages[0]!.content, /Do not nest softwareSystems, containers, components, or codeEntities/);
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
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { parsed: GATE_DOC, content: "" } }],
  }), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: "Here is the document:\n```json\n" + JSON.stringify(GATE_DOC) + "\n```\n" } }],
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
    assert.deepEqual(docs.get("container:pkg-a"), GATE_DOC);
    assert.deepEqual(docs.get("container:pkg-b"), GATE_DOC);
    assert.deepEqual(docs.get("system:acme"), GATE_DOC);
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

test("onUsage records fake-gateway usage onto a shared global spend ledger", async () => {
  const fakeKey = "okie-test-llm-key-cla38-fake";
  const spend = createGlobalEnrichmentSpend({ maxTokens: 10_000 });
  const fake = await listenFakeGateway((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(GATE_DOC, {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    })));
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
      budget: clampEnrichmentBudget(resolveEnrichmentBudget({}), spend),
      onUsage: usage => spend.record(usage),
      onProgress: note => notes.push(note),
    });
    await enrich(packets());
    assert.ok(spend.snapshot().tokens >= 10);
    assert.equal(spend.isExhausted(), false);
    assert.ok(notes.every(note => !note.includes(fakeKey)));
  } finally {
    await fake.close();
  }
});

test("billed malformed gateway replies still count toward the global cap", async () => {
  const fakeKey = "okie-test-llm-key-cla38-fake";
  const spend = createGlobalEnrichmentSpend({ maxTokens: 80 });
  const hits: number[] = [];
  const fake = await listenFakeGateway((_request, response) => {
    hits.push(1);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "not-json {" } }],
      usage: { prompt_tokens: 70, completion_tokens: 10, total_tokens: 80, cost: 0.02 },
    }));
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
      modelId: "acme/fast",
      gateway: client,
      budget: clampEnrichmentBudget(resolveEnrichmentBudget({}), spend),
      onUsage: usage => spend.record(usage),
      budgetExhausted: () => spend.isExhausted(),
      onProgress: note => notes.push(note),
    });
    await assert.rejects(() => enrich(packets()), /enrichment scope\(s\) failed|not JSON/);
    assert.equal(spend.snapshot().tokens, 80);
    assert.equal(spend.isExhausted(), true);
    assert.ok(hits.length >= 1);
    assert.ok(hits.length < 3, "remaining scopes must stop once the global cap is billed");
    assert.ok(notes.every(note => !note.includes(fakeKey)));
    assert.ok(JSON.stringify(spend.snapshot()).includes(fakeKey) === false);
  } finally {
    await fake.close();
  }
});

test("onUsage serializes scopes so a global token cap cannot be double-spent", async () => {
  const spend = createGlobalEnrichmentSpend({ maxTokens: 100 });
  const called: string[] = [];
  const enrich = createEnricher({
    budget: { maxTokens: 10_000 },
    onUsage: usage => spend.record(usage),
    budgetExhausted: () => spend.isExhausted(),
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
  assert.equal(spend.snapshot().tokens, 100);
  assert.equal(spend.isExhausted(), true);
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

function acmeExtraction() {
  const files: Record<string, string> = {
    "README.md": "# Acme\n",
    "pkg/a/package.json": `${JSON.stringify({ name: "@acme/a" }, null, 2)}\n`,
    "pkg/a/src/index.ts": "export function alpha() { return 1; }\n",
  };
  const read = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: {
      sourceFiles: ["pkg/a/src/index.ts"],
      units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" }],
      unitByFile: new Map([["pkg/a/src/index.ts", "pkg/a"]]),
      unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
      summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
    },
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  return { extraction, read };
}

function cla70NestedDump(
  packet: EnrichmentPacket,
  systemId: string,
  systemName: string,
  extraCode: object[] = [],
): Record<string, unknown> {
  return {
    softwareSystems: [{ id: systemId, name: systemName, responsibility: "Demo system." }],
    containers: [{
      id: packet.containerId,
      parentId: systemId,
      name: packet.containerName,
      responsibility: `Summary of ${packet.containerName}.`,
      sourceRefs: packet.scopePaths[0] ?? "pkg/a/src/index.ts",
    }],
    components: packet.components.map(component => ({
      id: component.id,
      parentId: packet.containerId,
      name: component.name,
      responsibility: `Summary of ${component.name}.`,
      sourceRefs: { path: component.path },
    })),
    codeEntities: extraCode,
  };
}

test("coerceGatewayExtractionDocument is identity for gate-shaped and OSS fixture docs", () => {
  assert.deepEqual(coerceGatewayExtractionDocument(GATE_DOC), GATE_DOC);
  const fixture = loadAppsWebFixture("container__apps-web.json");
  const coerced = coerceGatewayExtractionDocument(fixture) as ExtractionDoc;
  assert.equal(coerced.schemaVersion, 1);
  assert.ok(Array.isArray(coerced.entities));
  assert.deepEqual(coerced.entities.map(entity => entity.id), fixture.entities.map(entity => entity.id));
  assert.deepEqual(coerced.relations, []);
});

type CoercedEntity = {
  id: string;
  kind: string;
  parentId?: string;
  name: string;
  responsibility?: string;
  sourceRefs: Array<{ path: string; symbol?: string; startLine?: number; endLine?: number }>;
};

test("coerceGatewayExtractionDocument flattens CLA-70 nested C4 and wraps sourceRefs", () => {
  const nested = {
    softwareSystems: [{ id: "system:okie", name: "okie", responsibility: "Spatial atlas." }],
    containers: [{
      id: "container:apps-server",
      parentId: "system:okie",
      name: "@okie/server",
      responsibility: "Hosted scan HTTP.",
      sourceRefs: "apps/server/src/main.ts",
    }],
    components: [{
      id: "component:apps-server-src-main-ts",
      parentId: "container:apps-server",
      name: "src/main.ts",
      responsibility: "Binds the scan process.",
      sourceRefs: { path: "apps/server/src/main.ts", symbol: "main" },
    }],
    codeEntities: [{
      id: "code:apps-server-src-main-ts:main",
      name: "main",
      componentId: "component:apps-server-src-main-ts",
      path: "apps/server/src/main.ts",
      symbol: "main",
      startLine: 1,
      endLine: 4,
      responsibility: "Entry point.",
    }],
  };
  const coerced = coerceGatewayExtractionDocument(nested) as { schemaVersion: number; entities: CoercedEntity[]; relations: unknown[] };
  assert.equal(coerced.schemaVersion, 1);
  assert.ok(Array.isArray(coerced.entities));
  assert.deepEqual(coerced.relations, []);
  assert.equal("softwareSystems" in coerced, false);
  assert.equal("codeEntities" in coerced, false);
  const byId = new Map(coerced.entities.map(entity => [entity.id, entity]));
  assert.equal(byId.get("system:okie")?.kind, "softwareSystem");
  assert.equal(byId.get("container:apps-server")?.parentId, "system:okie");
  assert.deepEqual(byId.get("container:apps-server")?.sourceRefs, [{ path: "apps/server/src/main.ts" }]);
  assert.deepEqual(byId.get("component:apps-server-src-main-ts")?.sourceRefs, [{ path: "apps/server/src/main.ts", symbol: "main" }]);
  assert.equal(byId.get("code:apps-server-src-main-ts:main")?.parentId, "component:apps-server-src-main-ts");
  assert.deepEqual(byId.get("code:apps-server-src-main-ts:main")?.sourceRefs, [{
    path: "apps/server/src/main.ts", symbol: "main", startLine: 1, endLine: 4,
  }]);
});

test("coerceGatewayExtractionDocument flattens a nested softwareSystem.container tree", () => {
  const tree = {
    softwareSystem: {
      id: "system:okie",
      name: "okie",
      responsibility: "Spatial atlas.",
      container: {
        id: "container:apps-web",
        name: "@okie/web",
        responsibility: "React shell.",
        sourceRefs: [],
        components: [{
          id: "component:apps-web-src-app-tsx",
          name: "src/App.tsx",
          responsibility: "Application shell.",
          sourceRefs: [],
        }],
      },
    },
  };
  const coerced = coerceGatewayExtractionDocument(tree) as ExtractionDoc;
  assert.deepEqual(coerced.entities.map(entity => entity.id), [
    "system:okie",
    "container:apps-web",
    "component:apps-web-src-app-tsx",
  ]);
});

test("coerceGatewayExtractionDocument does not mint entity ids", () => {
  const coerced = coerceGatewayExtractionDocument({
    container: { name: "Web", responsibility: "UI shell." },
    softwareSystem: { name: "okie", responsibility: "Atlas." },
  }) as ExtractionDoc;
  assert.deepEqual(coerced.entities, []);
  assert.ok(!JSON.stringify(coerced).includes("container:"));
  assert.ok(!JSON.stringify(coerced).includes("system:okie"));
});

test("coerceGatewayExtractionDocument does not synthesize parent ids or trim source anchors", () => {
  const coerced = coerceGatewayExtractionDocument({
    softwareSystems: [{ id: "system:okie", name: "okie", responsibility: "Atlas." }],
    containers: [{
      id: "container:apps-web",
      name: "@okie/web",
      responsibility: "React shell.",
      sourceRefs: " apps/web/src/App.tsx ",
    }],
  }) as { entities: CoercedEntity[] };
  const container = coerced.entities.find(entity => entity.id === "container:apps-web");
  assert.equal(container?.parentId, undefined, "sibling arrays must not get a synthesized parentId");
  assert.deepEqual(container?.sourceRefs, [{ path: " apps/web/src/App.tsx " }]);
});

test("malformed sourceRefs and duplicate ids still reach the merge gate", () => {
  const coerced = coerceGatewayExtractionDocument({
    schemaVersion: 1,
    entities: [
      { id: "system:okie", kind: "softwareSystem", name: "okie", sourceRefs: [] },
      { id: "system:okie", kind: "softwareSystem", name: "okie-dup", sourceRefs: [42] },
    ],
    relations: [],
  }) as ExtractionDoc;
  assert.equal(coerced.entities.length, 2);
  assert.equal(coerced.entities[1]!.id, "system:okie");
  assert.deepEqual((coerced.entities[1] as CoercedEntity).sourceRefs, [42] as unknown as CoercedEntity["sourceRefs"]);
});

test("unknown source-anchor keys and non-array relations still reach the merge gate", () => {
  const coerced = coerceGatewayExtractionDocument({
    schemaVersion: 2,
    softwareSystems: [{ id: "system:okie", name: "okie", sourceRefs: [{ path: "README.md", commitSha: "abc" }] }],
    relations: "nope",
  }) as { schemaVersion: number; entities: CoercedEntity[]; relations: unknown };
  assert.equal(coerced.schemaVersion, 2);
  assert.deepEqual(coerced.relations, "nope");
  assert.deepEqual(coerced.entities[0]?.sourceRefs, [{ path: "README.md", commitSha: "abc" }] as unknown as CoercedEntity["sourceRefs"]);
});

test("a hallucinated id is still present after coerce so the gate can reject it", () => {
  const coerced = coerceGatewayExtractionDocument({
    entities: [
      { id: "system:okie", kind: "softwareSystem", name: "okie", sourceRefs: [] },
      { id: "code:ghost:nope", kind: "code", name: "nope", parentId: "component:missing", sourceRefs: [] },
    ],
  }) as ExtractionDoc;
  assert.ok(coerced.entities.some(entity => entity.id === "code:ghost:nope"));
});

test("live hop wraps CLA-70 nested dumps into documents the merge gate accepts", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const nested = cla70NestedDump(packet, system.id, system.name);
  const wrapped = parseChatCompletionDocument(chatCompletionReply(nested));
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[packet.containerId, wrapped]]));
  const result = report.results.find(item => item.containerId === packet.containerId);
  assert.equal(result?.accepted, true, result?.reasons.join("; "));
  const container = merged.entities.find(entity => entity.id === packet.containerId);
  assert.ok(container?.responsibility);
  assert.ok(!merged.entities.some(entity => entity.id === "code:ghost:nope"));
});

test("live hop still lets the gate reject a nested dump that invents an id", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const nested = cla70NestedDump(packet, system.id, system.name, [{
    id: "code:ghost:nope",
    name: "nope",
    path: packet.scopePaths[0],
    responsibility: "Hallucinated.",
  }]);
  const wrapped = coerceGatewayExtractionDocument(nested) as ExtractionDoc;
  assert.ok(wrapped.entities.some(entity => entity.id === "code:ghost:nope"));
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[packet.containerId, wrapped]]));
  assert.equal(report.results.find(item => item.containerId === packet.containerId)?.accepted, false);
  assert.equal(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility, undefined);
  assert.ok(!merged.entities.some(entity => entity.id === "code:ghost:nope"));
});

test("fake HTTP gateway nested C4 dump is coerced and accepted by the merge gate", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const fakeKey = "okie-test-llm-key-cla70-fake";
  const fake = await listenFakeGateway(async (request, response) => {
    const raw = await readRequestBody(request);
    const user = ((JSON.parse(raw) as { messages: Array<{ role: string; content: string }> })
      .messages.find(message => message.role === "user")?.content) ?? "";
    const document = user.includes("System packet:")
      ? {
        softwareSystem: {
          id: system.id,
          name: system.name,
          responsibility: "Demo system.",
          containers: [{
            id: packet.containerId,
            name: packet.containerName,
            responsibility: `Summary of ${packet.containerName}.`,
            sourceRefs: [],
          }],
        },
      }
      : cla70NestedDump(packet, system.id, system.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(document)));
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
    const docs = await enrich(emitted);
    const { report, extraction: merged } = mergeEnrichment(extraction, docs);
    const container = report.results.find(item => item.containerId === packet.containerId);
    assert.equal(container?.accepted, true, container?.reasons.join("; "));
    assert.ok(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility);
    assert.equal(report.systemScope?.accepted, true, report.systemScope?.reasons.join("; "));
  } finally {
    await fake.close();
  }
});
