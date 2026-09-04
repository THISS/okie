import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ArchitectureEntity,
  ArchitectureExcerptPacket,
  ArchitectureNeighborhoodPacket,
  ArchitectureRelation,
  ArchitectureSnapshot,
  ArchitectureView,
  EntityKind,
} from "@okie/architecture";
import { createGithubAuthService } from "./githubOAuth.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { healthzBody } from "./localDefaults.js";
import { createScanHttpHandler } from "./scanServer.js";
import { resetPublishedTrioCache } from "./scanNeighborhood.js";

function entity(id: string, kind: EntityKind, parentId?: string, excerpt = false): ArchitectureEntity {
  const lines = excerpt ? ["export const x = 1;", "export const y = 2;"] : undefined;
  const path = `src/${id.replaceAll(":", "/")}.ts`;
  return {
    id,
    name: id,
    kind,
    sourceRefs: [{ path, commitSha: "sha" }],
    ...(parentId ? { parentId } : {}),
    ...(lines ? {
      sourceExcerpts: [{
        path,
        language: "typescript" as const,
        startLine: 1,
        endLine: 2,
        highlightLine: 1,
        frozenRevision: "sha",
        lines,
        text: lines.join("\n"),
      }],
    } : {}),
  };
}

function relation(id: string, from: string, to: string, kind: ArchitectureRelation["kind"] = "uses"): ArchitectureRelation {
  return { id, from, to, kind, evidence: [{ source: { path: `src/${from.replaceAll(":", "/")}.ts`, commitSha: "sha" } }] };
}

function publishedTrio(): { snapshot: ArchitectureSnapshot; view: ArchitectureView; story: unknown } {
  const entities: ArchitectureEntity[] = [
    entity("system:root", "softwareSystem"),
    entity("actor:dev", "person"),
    entity("container:web", "container", "system:root"),
    entity("container:arch", "container", "system:root"),
    entity("component:web-app", "component", "container:web"),
    entity("component:arch-model", "component", "container:arch"),
  ];
  const relations: ArchitectureRelation[] = [
    relation("rel:dev-root", "actor:dev", "system:root"),
    relation("rel:root-web", "system:root", "container:web", "contains"),
  ];
  for (let index = 0; index < 40; index += 1) {
    const id = `code:web-${index}`;
    entities.push(entity(id, "code", "component:web-app", true));
    if (index > 0) relations.push(relation(`rel:uses-web-${index}`, `code:web-${index - 1}`, id));
  }
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:test",
    repositoryId: "repo:test",
    commitSha: "sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations,
  };
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:test",
    snapshotId: snapshot.id,
    name: "test",
    rootEntityId: "system:root",
    entityIds: entities.map(item => item.id),
    relationIds: relations.map(item => item.id),
    layout: {
      nodes: Object.fromEntries(entities.map((item, index) => [item.id, { x: index, y: 0, width: 4, height: 4 }])),
    },
  };
  const story = {
    schemaVersion: 1,
    id: "story:test",
    snapshotId: snapshot.id,
    viewId: view.id,
    title: "Overview",
    steps: [{
      id: "step:1",
      title: "Start",
      focusEntityIds: ["system:root"],
      narration: "The system.",
      reveal: "context",
    }],
  };
  return { snapshot, view, story };
}

async function withServer(
  handler: ReturnType<typeof createScanHttpHandler>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("CLA-73: neighborhood HTTP is far smaller than snapshot.json and strips excerpts", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-neighborhood-"));
  resetPublishedTrioCache();
  const { snapshot, view, story } = publishedTrio();
  mkdirSync(join(scanRoot, "thiss__okie"), { recursive: true });
  writeFileSync(join(scanRoot, "thiss__okie", "snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(join(scanRoot, "thiss__okie", "view.json"), JSON.stringify(view));
  writeFileSync(join(scanRoot, "thiss__okie", "story.json"), JSON.stringify(story));
  const handler = createScanHttpHandler({
    queue: createScanJobQueue(async () => {}),
    allowSubmit: createSubmitLimiter(),
    auth: createGithubAuthService({
      bind: "127.0.0.1",
      env: { OKIE_GITHUB_TEST_DOUBLE: "0", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
    }),
    scanRoot,
    llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4", keySource: "none" },
    enrich: "off",
    bind: "127.0.0.1",
  });
  try {
    await withServer(handler, async origin => {
      const full = await fetch(`${origin}/scan/thiss__okie/snapshot.json`);
      const neighborhood = await fetch(`${origin}/scan/thiss__okie/neighborhood.json?focus=system:root`);
      assert.equal(full.status, 200);
      assert.equal(neighborhood.status, 200);
      const fullBytes = (await full.arrayBuffer()).byteLength;
      const slimText = await neighborhood.text();
      const slimBytes = slimText.length;
      const packet = JSON.parse(slimText) as ArchitectureNeighborhoodPacket;
      assert.equal(packet.kind, "neighborhood");
      assert.equal(packet.focusEntityId, "system:root");
      assert.equal(packet.truncated, true);
      assert.equal(packet.snapshot.entities.some(item => item.kind === "code"), false);
      assert.equal(packet.snapshot.entities.some(item => item.sourceExcerpts?.length), false);
      assert.ok(slimBytes * 3 < fullBytes || slimBytes < 8_000, `neighborhood ${slimBytes}B vs snapshot ${fullBytes}B`);
      assert.doesNotMatch(slimText, /apiKey|scanRoot|gho_|OPENROUTER|\/home\//);

      const excerpt = await fetch(`${origin}/scan/thiss__okie/excerpt.json?entity=code:web-0`);
      assert.equal(excerpt.status, 200);
      const excerptPacket = await excerpt.json() as ArchitectureExcerptPacket;
      assert.equal(excerptPacket.kind, "excerpt");
      assert.ok(excerptPacket.sourceExcerpts[0]?.text.includes("export const x"));

      const missing = await fetch(`${origin}/scan/thiss__okie/excerpt.json?entity=code:missing`);
      assert.equal(missing.status, 404);

      const deep = await fetch(`${origin}/scan/thiss__okie/neighborhood.json?focus=container:web`);
      const deepPacket = await deep.json() as ArchitectureNeighborhoodPacket;
      assert.ok(deepPacket.snapshot.entities.some(item => item.id === "component:web-app"));
      assert.equal(deepPacket.snapshot.entities.some(item => item.id === "component:arch-model"), false);

      const health = await fetch(`${origin}/healthz`);
      const healthBody = await health.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(healthBody).sort(), ["bind", "enrich", "ok", "public", "service"]);
      assert.deepEqual(healthBody, healthzBody({ enrich: "off", bind: "127.0.0.1" }));
    });
  } finally {
    resetPublishedTrioCache();
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("neighborhood paths reject traversal and do not leak scanRoot", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-neighborhood-sec-"));
  resetPublishedTrioCache();
  const handler = createScanHttpHandler({
    queue: createScanJobQueue(async () => {}),
    allowSubmit: createSubmitLimiter(),
    auth: createGithubAuthService({
      bind: "127.0.0.1",
      env: { OKIE_GITHUB_TEST_DOUBLE: "0", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
    }),
    scanRoot,
    llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4", keySource: "none" },
    enrich: "off",
    bind: "127.0.0.1",
  });
  try {
    await withServer(handler, async origin => {
      const escaped = await fetch(`${origin}/scan/../neighborhood.json?focus=system:root`);
      const body = await escaped.text();
      assert.notEqual(escaped.status, 200);
      assert.doesNotMatch(body, new RegExp(scanRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(body, /scanRoot/);
    });
  } finally {
    resetPublishedTrioCache();
    rmSync(scanRoot, { recursive: true, force: true });
  }
});
