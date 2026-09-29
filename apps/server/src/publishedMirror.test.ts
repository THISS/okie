import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAskCorpusSource } from "./askRetrieval.js";
import { createAskIndexCache } from "./askRetrieval.js";
import { handleAskWorkerRequest } from "./askWorker.js";
import { publicationBlockPlanSource } from "./blockPlans.js";
import { resolveLlmGatewayConfig } from "./llmGateway.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore, type OperatorStoreState } from "./operatorStore.js";
import {
  createPublishedOperatorFixture,
  FIXTURE_CLAIM,
  FIXTURE_COMMIT,
  FIXTURE_REPOSITORY_ID,
  FIXTURE_SLUG,
  memoryStoreClient,
  FIXTURE_LICENSE,
  publishFixtureVersion,
} from "./publishedAtlas.fixture.js";
import { createPublishedMirror, publicationPointerPath, type PublishedMirror } from "./publishedMirror.js";
import { publishedPublicFileKey } from "./publishedStoreLayout.js";
import { buildPublishedVersion, publishBuiltVersion } from "./publishAtlas.js";
import { resetPublishedTrioCache } from "./scanNeighborhood.js";
import { createPublicReadonlyHttpHandler } from "./scanServer.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Serves `objects` at `/<key>` like the Worker's R2-backed store host; counts requests per key. */
function storeServer(objects: Map<string, Buffer>): { server: Server; hits: Map<string, number> } {
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const key = decodeURIComponent((request.url ?? "/").slice(1));
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const body = objects.get(key);
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json", "content-length": String(body.byteLength) });
    response.end(body);
  });
  return { server, hits };
}

const RAW_SOURCE = "export const a = 1;\nexport const b = 2;\n";
const fakeGithub: typeof fetch = async () => new Response(RAW_SOURCE, { status: 200 });

function mirrorHandler(scanRoot: string, mirror: PublishedMirror | undefined) {
  const store = new OperatorStore(scanRoot);
  const publications = new OperatorPublicationService(store);
  const handler = createPublicReadonlyHttpHandler({
    mode: "public-readonly",
    published: { publications, store },
    ...(mirror ? { ensurePublished: (slug: string, versionId?: string, hint?: { commitSha?: string }) => mirror.ensure(slug, versionId, hint) } : {}),
    scanRoot,
    llm: resolveLlmGatewayConfig({}),
    enrich: "off",
    bind: "127.0.0.1",
    sourceFetch: fakeGithub,
  });
  return { store, publications, handler };
}

test("CLA-266 mirror: materialises published versions so every read path works unchanged; picks up a new latest", async () => {
  const operatorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-operator-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-scratch-"));
  const client = memoryStoreClient();
  const { server: r2, hits } = storeServer(client.objects);
  let app: Server | undefined;
  try {
    const fixture = createPublishedOperatorFixture(operatorRoot);
    const first = fixture.publication;
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const storeUrl = await listen(r2);

    // The mirror's store is opened first (as in the container), then synced.
    const { store, publications, handler } = mirrorHandler(mirrorRoot, undefined);
    const mirror = createPublishedMirror({ storeUrl: `${storeUrl}/`, store, refreshMs: 0 });
    await mirror.sync();
    assert.deepEqual(mirror.stats().slugs, [FIXTURE_SLUG]);

    // Minimal operator-v1 state: one complete run per slug, the artifact, the publication; pointer at the latest.
    const state = JSON.parse(readFileSync(join(store.root, "state.json"), "utf8")) as OperatorStoreState;
    assert.deepEqual(state.runs.map(run => [run.source.slug, run.source.repositoryId, run.state]), [[FIXTURE_SLUG, FIXTURE_REPOSITORY_ID, "complete"]]);
    assert.deepEqual(state.publications.map(value => [value.versionId, value.artifactRevisionId]), [[first.versionId, first.artifactRevisionId]]);
    // Only what container routes read: snapshot + view + the raw sidecar (story.json etc. are served by the Worker from R2).
    assert.deepEqual([...state.artifacts[0]!.files], ["operator-explanations.json", "snapshot.json", "view.json"]);
    assert.equal(state.artifacts[0]!.sourceCommitSha, FIXTURE_COMMIT);
    assert.deepEqual([state.drafts, state.attempts, state.explanations, state.events], [[], [], [], []]);
    assert.equal(JSON.parse(readFileSync(publicationPointerPath(store.root, FIXTURE_REPOSITORY_ID), "utf8")).versionId, first.versionId);
    assert.ok(readFileSync(join(store.root, "artifacts", first.artifactRevisionId, "operator-explanations.json"), "utf8").includes(FIXTURE_CLAIM), "the artifact sidecar is the raw private one");
    assert.equal(publications.currentForSlug(FIXTURE_SLUG)?.versionId, first.versionId);

    // Reference: the same routes over the operator's own store.
    const reference = createPublicReadonlyHttpHandler({ mode: "public-readonly", published: { publications: fixture.publications, store: fixture.store }, scanRoot: operatorRoot, llm: resolveLlmGatewayConfig({}), enrich: "off", bind: "127.0.0.1", sourceFetch: fakeGithub });
    const referenceServer = createServer((request, response) => { void reference(request, response); });
    const referenceOrigin = await listen(referenceServer);
    app = createServer((request, response) => { void handler(request, response); });
    const origin = await listen(app);
    try {
      const both = async (path: string) => {
        const [mirrored, original] = await Promise.all([fetch(`${origin}${path}`), fetch(`${referenceOrigin}${path}`)]);
        const [left, right] = [await mirrored.text(), await original.text()];
        assert.equal(mirrored.status, original.status, path);
        assert.equal(left, right, path);
        return { status: mirrored.status, text: left };
      };
      const neighborhood = await both(`/scan/${FIXTURE_SLUG}/neighborhood.json`);
      assert.deepEqual(JSON.parse(neighborhood.text).publication, { versionId: first.versionId, artifactRevisionId: first.artifactRevisionId });
      await both(`/scan/${FIXTURE_SLUG}/neighborhood.json?focus=container:web`);
      await both(`/scan/${FIXTURE_SLUG}/excerpt.json?entity=code:web-2`);
      for (const file of ["snapshot.json", "view.json", "operator-explanations.json"]) await both(`/scan/${FIXTURE_SLUG}/${file}`);
      assert.equal((await fetch(`${origin}/scan/${FIXTURE_SLUG}/story.json`)).status, 404, "not mirrored: the Worker serves it from R2");
      assert.equal(hits.get(publishedPublicFileKey(FIXTURE_SLUG, first.versionId, "story.json")), undefined, "never downloaded");
      const operatorExplanations = await both(`/scan/${FIXTURE_SLUG}/operator-explanations.json?version=${first.versionId}`);
      assert.ok(!operatorExplanations.text.includes(FIXTURE_CLAIM), "claims never reach the public surface");
      const source = await both(`/scan/${FIXTURE_SLUG}/source.json?owner=acme&repo=demo&commit=${FIXTURE_COMMIT}&path=src/code/web-2.ts&start=1&end=2&version=${first.versionId}`);
      assert.equal(source.status, 200);
      assert.deepEqual(JSON.parse(source.text).lines, ["export const a = 1;", "export const b = 2;"]);
      assert.equal((await fetch(`${origin}/scan/${FIXTURE_SLUG}/atlas.okie.json`)).status, 404);

      // Ask corpus + worker retrieval over the mirrored artifact.
      const locations = createAskCorpusSource({ scanRoot: mirrorRoot, publications, store }).locate({ slug: FIXTURE_SLUG, owner: "acme", repo: "demo", commitSha: FIXTURE_COMMIT });
      assert.equal(locations.length, 1);
      assert.equal(locations[0]!.source, "publication");
      assert.ok(locations[0]!.sidecarPath);
      const reply = handleAskWorkerRequest(createAskIndexCache(), { id: 1, commitSha: FIXTURE_COMMIT, candidates: locations, buildKeys: [locations[0]!.key], question: "What does the web shell render?", selectedIds: [], byteBudget: 8_000 });
      assert.ok(reply.ok && reply.evidence && reply.evidence.sections.length > 0);
      // Block-plan source: the current publication for the slug.
      assert.deepEqual(publicationBlockPlanSource(publications, store).current(FIXTURE_SLUG), { versionId: first.versionId, artifactRevisionId: first.artifactRevisionId });

      // Unchanged index: a refresh is one request.
      const before = [...hits.values()].reduce((sum, count) => sum + count, 0);
      await mirror.refresh();
      assert.equal([...hits.values()].reduce((sum, count) => sum + count, 0), before + 1);

      // A new latest is picked up after refresh; the old version stays pinned for sessions that asked for it.
      const second = publishFixtureVersion(fixture.store, fixture.publications, fixture.runId, "Second", first.versionId);
      await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
      await mirror.refresh();
      resetPublishedTrioCache();
      const moved = await both(`/scan/${FIXTURE_SLUG}/neighborhood.json`);
      assert.deepEqual(JSON.parse(moved.text).publication, { versionId: second.versionId, artifactRevisionId: second.artifactRevisionId });
      assert.match(moved.text, /Second system/);
      const pinned = await both(`/scan/${FIXTURE_SLUG}/neighborhood.json?version=${first.versionId}`);
      assert.deepEqual(JSON.parse(pinned.text).publication, { versionId: first.versionId, artifactRevisionId: first.artifactRevisionId });
      // An unknown version is a closed 404, never another version's bytes.
      assert.equal((await fetch(`${origin}/scan/${FIXTURE_SLUG}/neighborhood.json?version=publication-missing`)).status, 404);
      assert.equal((await fetch(`${origin}/scan/${FIXTURE_SLUG}/snapshot.json?version=publication-missing`)).status, 404);
    } finally { await close(referenceServer); }
  } finally {
    resetPublishedTrioCache();
    if (app) await close(app);
    await close(r2);
    rmSync(operatorRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test("CLA-266 mirror: on-demand install for a slug or pinned version it lacks; misses are closed, deduped and remembered", async () => {
  const operatorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-demand-op-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-demand-"));
  const client = memoryStoreClient();
  const { server: r2, hits } = storeServer(client.objects);
  let app: Server | undefined;
  try {
    const fixture = createPublishedOperatorFixture(operatorRoot);
    const first = fixture.publication;
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const second = publishFixtureVersion(fixture.store, fixture.publications, fixture.runId, "Second", first.versionId);
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const storeUrl = await listen(r2);
    const store = new OperatorStore(mirrorRoot);
    const mirror = createPublishedMirror({ storeUrl, store, refreshMs: 0, negativeTtlMs: 60_000 });
    const { handler } = mirrorHandler(mirrorRoot, mirror);
    app = createServer((request, response) => { void handler(request, response); });
    const origin = await listen(app);

    // No sync: the first request for the slug installs its latest.
    const [a, b] = await Promise.all([fetch(`${origin}/scan/${FIXTURE_SLUG}/neighborhood.json`), fetch(`${origin}/scan/${FIXTURE_SLUG}/view.json`)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await a.json() as { publication: { versionId: string } }).publication.versionId, second.versionId);
    assert.equal(hits.get(`atlas/v1/repos/${FIXTURE_SLUG}/latest.json`), 1, "concurrent requests share one install");
    // A pinned older version is fetched on demand.
    const pinned = await fetch(`${origin}/scan/${FIXTURE_SLUG}/neighborhood.json?version=${first.versionId}`);
    assert.equal(pinned.status, 200);
    assert.equal((await pinned.json() as { publication: { versionId: string } }).publication.versionId, first.versionId);

    // Unknown slugs and versions: closed 404, looked up once within the negative TTL.
    for (let count = 0; count < 3; count += 1) {
      assert.equal((await fetch(`${origin}/scan/nobody__here/neighborhood.json`)).status, 404);
      assert.equal((await fetch(`${origin}/scan/${FIXTURE_SLUG}/view.json?version=publication-nope`)).status, 404);
    }
    assert.equal(hits.get("atlas/v1/repos/nobody__here/latest.json"), 1);
    assert.equal(hits.get(`atlas/v1/repos/${FIXTURE_SLUG}/versions/publication-nope/manifest.json`), 1);
    // Invalid slugs never reach the store.
    assert.equal((await fetch(`${origin}/scan/Bad.Slug/neighborhood.json`)).status, 404);
    assert.ok(![...hits.keys()].some(key => key.includes("Bad.Slug")));
  } finally {
    resetPublishedTrioCache();
    if (app) await close(app);
    await close(r2);
    rmSync(operatorRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test("CLA-266 mirror: a file that does not match its manifest is never installed", async () => {
  const operatorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-tamper-op-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-tamper-"));
  const client = memoryStoreClient();
  const { server: r2 } = storeServer(client.objects);
  try {
    const fixture = createPublishedOperatorFixture(operatorRoot);
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const key = publishedPublicFileKey(FIXTURE_SLUG, fixture.publication.versionId, "snapshot.json");
    const original = client.objects.get(key)!;
    client.objects.set(key, Buffer.concat([original.subarray(0, original.length - 2), Buffer.from(" }")]));
    const store = new OperatorStore(mirrorRoot);
    const lines: string[] = [];
    const mirror = createPublishedMirror({ storeUrl: await listen(r2), store, refreshMs: 0, log: line => lines.push(line) });
    await mirror.sync();
    assert.deepEqual(mirror.stats().slugs, []);
    assert.ok(lines.some(line => /does not match its manifest/.test(line)));
    assert.equal(new OperatorPublicationService(store).currentForSlug(FIXTURE_SLUG), undefined);
    // Once the object is repaired, the next sync installs it.
    client.objects.set(key, original);
    await mirror.sync();
    assert.deepEqual(mirror.stats().slugs, [FIXTURE_SLUG]);
  } finally {
    await close(r2);
    rmSync(operatorRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test("CLA-266 mirror: a failed refresh does not advance past the index; the next refresh recovers", async () => {
  const operatorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-retry-op-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-retry-"));
  const client = memoryStoreClient();
  const failing = new Set<string>();
  const hits = new Map<string, number>();
  const r2 = createServer((request, response) => {
    const key = decodeURIComponent((request.url ?? "/").slice(1));
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (failing.has(key)) { response.writeHead(503); response.end(); return; }
    const body = client.objects.get(key);
    response.writeHead(body ? 200 : 404);
    response.end(body);
  });
  try {
    const fixture = createPublishedOperatorFixture(operatorRoot);
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const store = new OperatorStore(mirrorRoot);
    const lines: string[] = [];
    const mirror = createPublishedMirror({ storeUrl: await listen(r2), store, refreshMs: 0, log: line => lines.push(line) });
    await mirror.sync();
    const current = () => new OperatorPublicationService(store).currentForSlug(FIXTURE_SLUG)?.versionId;
    assert.equal(current(), fixture.publication.versionId);

    // A new version is published, but its snapshot read fails during the refresh that sees the new index.
    const second = publishFixtureVersion(fixture.store, fixture.publications, fixture.runId, "Second", fixture.publication.versionId);
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const snapshotKey = publishedPublicFileKey(FIXTURE_SLUG, second.versionId, "snapshot.json");
    failing.add(snapshotKey);
    await mirror.refresh();
    assert.equal(current(), fixture.publication.versionId, "still serving the old version");
    assert.ok(lines.some(line => /sync acme__demo failed/.test(line)));
    await mirror.refresh();
    assert.equal(hits.get(snapshotKey), 2, "the unchanged index does not stop the retry");

    // The store recovers: the next refresh installs the new version (before the fix the digest had advanced: never).
    failing.delete(snapshotKey);
    await mirror.refresh();
    assert.equal(current(), second.versionId);
    // Once everything synced, an unchanged index is one request again.
    const before = [...hits.values()].reduce((sum, count) => sum + count, 0);
    await mirror.refresh();
    assert.equal([...hits.values()].reduce((sum, count) => sum + count, 0), before + 1);
  } finally {
    await close(r2);
    rmSync(operatorRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test("CLA-266 mirror: a request naming a version or commit that is not current re-reads latest.json (bounded, deduped)", async () => {
  const operatorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-recheck-op-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "okie-mirror-recheck-"));
  const client = memoryStoreClient();
  const { server: r2, hits } = storeServer(client.objects);
  let app: Server | undefined;
  try {
    const fixture = createPublishedOperatorFixture(operatorRoot);
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const store = new OperatorStore(mirrorRoot);
    let clock = 1_000_000;
    const mirror = createPublishedMirror({ storeUrl: await listen(r2), store, refreshMs: 0, latestRecheckMs: 10_000, now: () => clock });
    await mirror.sync();
    const { handler, publications } = mirrorHandler(mirrorRoot, mirror);
    app = createServer((request, response) => { void handler(request, response); });
    const origin = await listen(app);
    const latestKey = `atlas/v1/repos/${FIXTURE_SLUG}/latest.json`;
    assert.equal(hits.get(latestKey), 1);

    // Latest moves in the store; no refresh runs. Requests pinned to the new version trigger ONE latest re-read.
    const second = publishFixtureVersion(fixture.store, fixture.publications, fixture.runId, "Second", fixture.publication.versionId);
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const responses = await Promise.all([1, 2, 3].map(() => fetch(`${origin}/scan/${FIXTURE_SLUG}/neighborhood.json?version=${second.versionId}`)));
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
    assert.equal(hits.get(latestKey), 2, "concurrent requests share one re-read");
    assert.equal(publications.currentForSlug(FIXTURE_SLUG)?.versionId, second.versionId, "the new version is now current, not merely pinned");
    resetPublishedTrioCache();
    const unpinned = await fetch(`${origin}/scan/${FIXTURE_SLUG}/neighborhood.json`);
    assert.equal((await unpinned.json() as { publication: { versionId: string } }).publication.versionId, second.versionId);

    // An old pinned version or an unknown commit re-reads at most once per latestRecheckMs.
    clock += 10_000;
    for (let count = 0; count < 3; count += 1) {
      assert.equal((await fetch(`${origin}/scan/${FIXTURE_SLUG}/view.json?version=${fixture.publication.versionId}`)).status, 200);
    }
    assert.equal(hits.get(latestKey), 3);
    await mirror.ensure(FIXTURE_SLUG, undefined, { commitSha: "f".repeat(40) });
    assert.equal(hits.get(latestKey), 3, "still inside the recheck window");
    clock += 10_000;
    await mirror.ensure(FIXTURE_SLUG, undefined, { commitSha: "f".repeat(40) });
    assert.equal(hits.get(latestKey), 4, "a commit the current version is not on re-reads after the window");
    clock += 10_000;
    await mirror.ensure(FIXTURE_SLUG, undefined, { commitSha: FIXTURE_COMMIT });
    await mirror.ensure(FIXTURE_SLUG, second.versionId);
    assert.equal(hits.get(latestKey), 4, "the current version/commit never re-reads");
  } finally {
    resetPublishedTrioCache();
    if (app) await close(app);
    await close(r2);
    rmSync(operatorRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});
