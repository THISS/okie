import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  createPublishedOperatorFixture,
  FIXTURE_CLAIM,
  FIXTURE_COMMIT,
  FIXTURE_LICENSE,
  FIXTURE_SLUG,
  memoryStoreClient,
  publishFixtureVersion,
} from "./publishedAtlas.fixture.js";
import {
  backfillPublishedNames,
  buildPublishedVersion,
  createDirectoryStoreClient,
  createWranglerStoreClient,
  gzipMember,
  normalizeSpdxLicenseOverride,
  preparePublishedVersion,
  PUBLISH_BUCKETS,
  publishBuiltVersion,
  resolveGithubRepositoryNames,
  resolvePublishedLicense,
  setPublishedLatest,
  wranglerChildEnv,
  type PublishStoreClient,
  type WranglerRunner,
} from "./publishAtlas.js";
import {
  publishedIndexKey,
  publishedLatestKey,
  publishedManifestKey,
  publishedPackIndexKey,
  publishedPackKey,
  publishedPrivateFileKey,
  publishedPublicFileKey,
  publishedSourcePathsKey,
  type PublishedPackIndex,
  type PublishedSourcePaths,
} from "./publishedStoreLayout.js";
import { resolveLlmGatewayConfig } from "./llmGateway.js";
import { resetPublishedTrioCache } from "./scanNeighborhood.js";
import { createPublicReadonlyHttpHandler } from "./scanServer.js";

async function withHandler(handler: ReturnType<typeof createPublicReadonlyHttpHandler>, run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  try { await run(`http://127.0.0.1:${address.port}`); } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function treeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path); else out[path.slice(root.length)] = `${stat.size}:${stat.mtimeMs}:${readFileSync(path).toString("base64")}`;
    }
  };
  walk(root);
  return out;
}

/** One range read of a gzip pack, inflated on its own (each entry is a complete gzip member). */
const slice = (pack: Buffer, index: PublishedPackIndex, key: string): string | undefined => {
  assert.equal(index.encoding, "gzip");
  const entry = index.entries[key];
  return entry ? gunzipSync(pack.subarray(entry[0], entry[0] + entry[1])).toString("utf8") : undefined;
};

test("CLA-266 publish: read-only over the operator store; packs are byte-identical to the server routes", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-"));
  try {
    const { store, publications, publication } = createPublishedOperatorFixture(scanRoot);
    const before = treeSnapshot(scanRoot);
    const built = buildPublishedVersion({ scanRoot, repo: "Acme/Demo", license: FIXTURE_LICENSE });
    assert.deepEqual(treeSnapshot(scanRoot), before, "publish never writes to the operator store (no lock file, no state rewrite)");
    assert.equal(existsSync(join(scanRoot, "operator-v1", ".lock")), false);

    assert.equal(built.slug, FIXTURE_SLUG);
    assert.equal(built.versionId, publication.versionId);
    assert.equal(built.manifest.artifactRevisionId, publication.artifactRevisionId);
    assert.deepEqual(Object.keys(built.manifest.public).sort(), ["operator-explanations.json", "snapshot.json", "story.json", "view.json"]);
    assert.deepEqual(Object.keys(built.manifest.private), ["operator-explanations.json"]);
    const keys = built.objects.map(object => object.key);
    assert.ok(!keys.some(key => key.includes("atlas.okie.json")), "non-public artifact files are never published");
    const object = (key: string) => built.objects.find(value => value.key === key)!.bytes;
    // The private sidecar is the raw artifact; the public one is claim-stripped.
    assert.ok(object(publishedPrivateFileKey(FIXTURE_SLUG, built.versionId, "operator-explanations.json")).toString().includes(FIXTURE_CLAIM));
    assert.ok(!object(publishedPublicFileKey(FIXTURE_SLUG, built.versionId, "operator-explanations.json")).toString().includes(FIXTURE_CLAIM));
    for (const [name, entry] of Object.entries(built.manifest.public)) assert.equal(object(publishedPublicFileKey(FIXTURE_SLUG, built.versionId, name)).byteLength, entry.bytes);

    const neighborhoodPack = object(publishedPackKey(FIXTURE_SLUG, built.versionId, "neighborhood"));
    const neighborhoodIndex = JSON.parse(object(publishedPackIndexKey(FIXTURE_SLUG, built.versionId, "neighborhood")).toString()) as PublishedPackIndex;
    const excerptPack = object(publishedPackKey(FIXTURE_SLUG, built.versionId, "excerpt"));
    const excerptIndex = JSON.parse(object(publishedPackIndexKey(FIXTURE_SLUG, built.versionId, "excerpt")).toString()) as PublishedPackIndex;
    // Every entity (leaves included) plus the default view.
    assert.deepEqual(Object.keys(neighborhoodIndex.entries).sort(), ["", ...Object.keys(excerptIndex.entries)].sort());
    assert.equal(built.manifest.packs.neighborhood?.entries, built.manifest.entityCount + 1);
    assert.equal(built.manifest.packs.neighborhood?.encoding, "gzip");
    assert.equal(built.manifest.packs.excerpt?.encoding, "gzip");
    assert.equal(Object.keys(excerptIndex.entries).length, built.manifest.entityCount);
    assert.ok(built.stats.neighborhoodPackBytes < built.stats.neighborhoodRawBytes, "entries are stored compressed");
    assert.equal(built.stats.neighborhoodPackBytes, neighborhoodPack.byteLength);
    assert.deepEqual(built.manifest.license, FIXTURE_LICENSE);
    assert.deepEqual(built.indexEntry.license, FIXTURE_LICENSE);
    assert.equal(built.indexEntry.repositoryId, "repo:acme-demo", "the listing keeps the snapshot's repository id");

    // source-paths.json: sorted unique sourceRefs paths at the snapshot commit, recorded in the manifest.
    const sourcePathsBytes = object(publishedSourcePathsKey(FIXTURE_SLUG, built.versionId));
    const sourcePaths = JSON.parse(sourcePathsBytes.toString()) as PublishedSourcePaths;
    assert.deepEqual([sourcePaths.owner, sourcePaths.repo, sourcePaths.commitSha], ["acme", "demo", FIXTURE_COMMIT]);
    assert.ok(sourcePaths.paths.includes("src/code/web-2.ts") && sourcePaths.paths.includes("src/system/root.ts"));
    assert.deepEqual(sourcePaths.paths, [...new Set(sourcePaths.paths)].sort());
    assert.equal(built.manifest.sourcePaths?.bytes, sourcePathsBytes.byteLength);

    const handler = createPublicReadonlyHttpHandler({
      mode: "public-readonly", published: { publications, store }, scanRoot, llm: resolveLlmGatewayConfig({}), enrich: "off", bind: "127.0.0.1",
    });
    await withHandler(handler, async origin => {
      const body = async (path: string) => { const response = await fetch(`${origin}${path}`); assert.equal(response.status, 200, path); return response.text(); };
      // Default, parents and leaves.
      for (const focus of ["", "system:root", "container:web", "component:web-app", "code:web-3", "actor:dev"]) {
        const query = focus ? `?focus=${encodeURIComponent(focus)}` : "";
        assert.equal(slice(neighborhoodPack, neighborhoodIndex, focus), await body(`/scan/${FIXTURE_SLUG}/neighborhood.json${query}`), `neighborhood ${focus || "(default)"}`);
        assert.equal(slice(neighborhoodPack, neighborhoodIndex, focus), await body(`/scan/${FIXTURE_SLUG}/neighborhood.json${query}${query ? "&" : "?"}version=${built.versionId}`), "pinned version is the same body");
      }
      for (const entity of ["code:web-3", "component:web-app", "actor:dev"]) {
        assert.equal(slice(excerptPack, excerptIndex, entity), await body(`/scan/${FIXTURE_SLUG}/excerpt.json?entity=${encodeURIComponent(entity)}`), `excerpt ${entity}`);
      }
      assert.equal(object(publishedPublicFileKey(FIXTURE_SLUG, built.versionId, "operator-explanations.json")).toString(), await body(`/scan/${FIXTURE_SLUG}/operator-explanations.json`));
      assert.equal(object(publishedPublicFileKey(FIXTURE_SLUG, built.versionId, "snapshot.json")).toString(), await body(`/scan/${FIXTURE_SLUG}/snapshot.json`));
    });
  } finally { resetPublishedTrioCache(); rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 publish: files and packs, then manifest, then latest, then a merged index; versions are immutable", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-order-"));
  try {
    const { store, publications, runId, publication } = createPublishedOperatorFixture(scanRoot);
    const client = memoryStoreClient();
    client.objects.set(publishedIndexKey(), Buffer.from(JSON.stringify({ schema: "okie.published-index/v1", schemaVersion: 1, repos: [{ slug: "other__repo", owner: "other", repo: "repo", repositoryId: "repo:other-repo", versionId: "v1", commitSha: "c", generatedAt: "g", entityCount: 1, publishedAt: "p" }] })));
    const built = buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE });
    const first = await publishBuiltVersion(built, client);
    assert.equal(first.version, "uploaded");
    const manifestAt = client.order.indexOf(publishedManifestKey(FIXTURE_SLUG, built.versionId));
    assert.equal(manifestAt, built.objects.length, "manifest after every version object");
    assert.deepEqual(client.order.slice(manifestAt + 1), [publishedLatestKey(FIXTURE_SLUG), publishedIndexKey()]);
    const index = JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { schemaVersion: number; repos: Array<{ slug: string; versionId: string }> };
    assert.equal(index.schemaVersion, 1);
    assert.deepEqual(index.repos.map(repo => [repo.slug, repo.versionId]), [[FIXTURE_SLUG, publication.versionId], ["other__repo", "v1"]]);
    assert.equal(JSON.parse(client.objects.get(publishedLatestKey(FIXTURE_SLUG))!.toString()).versionId, publication.versionId);

    // Idempotent re-publish of the identical version: no version object is rewritten.
    client.order.length = 0;
    const again = await publishBuiltVersion(buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    assert.equal(again.version, "unchanged");
    assert.deepEqual(client.order, [publishedLatestKey(FIXTURE_SLUG), publishedIndexKey()]);

    // A different manifest under the same version prefix is refused before anything is written.
    client.objects.set(publishedManifestKey(FIXTURE_SLUG, built.versionId), Buffer.from("{\"tampered\":true}\n"));
    client.order.length = 0;
    await assert.rejects(publishBuiltVersion(built, client), /refusing to overwrite/);
    assert.deepEqual(client.order, []);

    // A new operator publication becomes a new version and moves latest.
    client.objects.set(publishedManifestKey(FIXTURE_SLUG, built.versionId), built.manifestBytes);
    const next = publishFixtureVersion(store, publications, runId, "Second", publication.versionId);
    const nextBuilt = buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE });
    assert.equal(nextBuilt.versionId, next.versionId);
    assert.equal(nextBuilt.manifest.previousVersionId, publication.versionId);
    await publishBuiltVersion(nextBuilt, client);
    assert.equal(JSON.parse(client.objects.get(publishedLatestKey(FIXTURE_SLUG))!.toString()).versionId, next.versionId);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 publish: unknown repositories and stores without a current publication fail clearly", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-missing-"));
  try {
    assert.throws(() => buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), /no operator store/);
    createPublishedOperatorFixture(scanRoot);
    assert.throws(() => buildPublishedVersion({ scanRoot, repo: "acme/other", license: FIXTURE_LICENSE }), /no current publication/);
    assert.throws(() => buildPublishedVersion({ scanRoot, repo: "not a repo", license: FIXTURE_LICENSE }), /owner\/name/);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 publish: gzip members are deterministic; an oversized pack fails loudly", () => {
  const body = Buffer.from(`${JSON.stringify({ hello: "world".repeat(50) })}\n`);
  const member = gzipMember(body);
  assert.ok(member.equals(gzipMember(body)));
  assert.equal(member[9], 0xff, "OS byte pinned so packs are identical across platforms");
  assert.equal(gunzipSync(member).toString(), body.toString());
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-big-"));
  try {
    createPublishedOperatorFixture(scanRoot);
    assert.throws(() => buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE, maxPackBytes: 1024 }), /neighborhood pack is \d+ bytes, over the 1024-byte single-object limit/);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 publish: licence from the GitHub licence API at the pinned commit, unauthenticated; missing → refuse unless overridden", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const github = (status: number, body: unknown): typeof fetch => async (input, init) => {
    requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const at = { owner: "acme", repo: "demo", commitSha: FIXTURE_COMMIT };
  const license = await resolvePublishedLicense({ ...at, fetch: github(200, { path: "LICENSE.md", license: { spdx_id: "Apache-2.0", name: "Apache License 2.0" } }) });
  assert.deepEqual(license, { spdxId: "Apache-2.0", name: "Apache License 2.0", url: `https://github.com/acme/demo/blob/${FIXTURE_COMMIT}/LICENSE.md` });
  assert.equal(requests[0]!.url, `https://api.github.com/repos/acme/demo/license?ref=${FIXTURE_COMMIT}`);
  assert.equal(requests[0]!.headers.authorization, undefined, "never an operator token");

  await assert.rejects(resolvePublishedLicense({ ...at, fetch: github(404, { message: "Not Found" }) }), /no licence file.*--license-override/);
  await assert.rejects(resolvePublishedLicense({ ...at, fetch: github(200, { path: "LICENSE", license: { spdx_id: "NOASSERTION", name: "Other" } }) }), /could not identify.*NOASSERTION/);
  await assert.rejects(resolvePublishedLicense({ ...at, fetch: github(403, { message: "rate limited" }) }), /HTTP 403/);
  await assert.rejects(resolvePublishedLicense({ ...at, fetch: async () => { throw new Error("offline"); } }), /lookup .* failed \(offline\)/);
  const before = requests.length;
  assert.deepEqual(await resolvePublishedLicense({ ...at, override: "NOASSERTION", fetch: github(404, {}) }), { spdxId: "NOASSERTION", name: "NOASSERTION" });
  assert.equal(requests.length, before, "an override skips the lookup");
  await assert.rejects(resolvePublishedLicense({ ...at, override: "MIT; rm -rf" }), /SPDX id/);
  assert.deepEqual(await resolvePublishedLicense({ ...at, override: "  MIT   AND CC-BY-4.0 " }), { spdxId: "MIT AND CC-BY-4.0", name: "MIT AND CC-BY-4.0" });
  await assert.rejects(resolvePublishedLicense({ ...at, override: "MIT and CC-BY-4.0" }), /SPDX expression/);

  // End to end: the resolved licence lands in the manifest and the index row.
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-license-"));
  try {
    createPublishedOperatorFixture(scanRoot);
    const built = await preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: github(200, { path: "LICENSE", license: { spdx_id: "MIT", name: "MIT License" } }) });
    assert.deepEqual(built.manifest.license, FIXTURE_LICENSE);
    assert.deepEqual(built.indexEntry.license, FIXTURE_LICENSE);
    await assert.rejects(preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: github(404, {}) }), /refusing to publish/);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 publish: --set-latest rolls the pointer and index back to a stored version, uploading nothing else", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-rollback-"));
  const outDir = mkdtempSync(join(tmpdir(), "okie-publish-rollback-out-"));
  try {
    const { store, publications, runId, publication } = createPublishedOperatorFixture(scanRoot);
    const client = createDirectoryStoreClient(outDir);
    const first = buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE });
    await publishBuiltVersion(first, client);
    const firstIndex = readFileSync(join(outDir, publishedIndexKey()));
    const firstLatest = readFileSync(join(outDir, publishedLatestKey(FIXTURE_SLUG)));
    publishFixtureVersion(store, publications, runId, "Second", publication.versionId);
    const second = buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE });
    await publishBuiltVersion(second, client);
    assert.equal(JSON.parse(readFileSync(join(outDir, publishedLatestKey(FIXTURE_SLUG)), "utf8")).versionId, second.versionId);

    const writes: string[] = [];
    const recording: PublishStoreClient = { get: key => client.get(key), put: async (key, bytes, type) => { writes.push(key); await client.put(key, bytes, type); } };
    const result = await setPublishedLatest({ repo: "Acme/Demo", versionId: first.versionId, client: recording });
    assert.equal(result.slug, FIXTURE_SLUG);
    assert.deepEqual(writes, [publishedLatestKey(FIXTURE_SLUG), publishedIndexKey()], "latest then index; nothing else");
    assert.ok(readFileSync(join(outDir, publishedLatestKey(FIXTURE_SLUG))).equals(firstLatest), "the same pointer the original publish wrote");
    assert.ok(readFileSync(join(outDir, publishedIndexKey())).equals(firstIndex), "the index row is rebuilt from the manifest alone");

    // A version that is not in the store is refused before anything is written.
    writes.length = 0;
    await assert.rejects(setPublishedLatest({ repo: "acme/demo", versionId: "publication-missing", client: recording }), /is not in this store/);
    await assert.rejects(setPublishedLatest({ repo: "other/repo", versionId: first.versionId, client: recording }), /is not in this store/);
    await assert.rejects(setPublishedLatest({ repo: "acme/demo", versionId: "../x", client: recording }), /version id/);
    assert.deepEqual(writes, []);
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("CLA-266 publish: wrangler uses the `wrangler login` session — account id by name, API tokens stripped", async () => {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const run: WranglerRunner = async (args, env) => {
    calls.push({ args, env });
    if (args[2] === "get") return { code: 1, stdout: "", stderr: "\n✘ [ERROR] The specified key does not exist.\n\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.doesNotThrow(() => wranglerChildEnv("staging", {}), "the account falls back to wrangler.jsonc account_id / OAuth");
  assert.equal(wranglerChildEnv("production", { CLOUDFLARE_API_TOKEN: "t" }).env.CLOUDFLARE_API_TOKEN, undefined);
  assert.doesNotThrow(() => wranglerChildEnv("local", {}));
  assert.deepEqual(wranglerChildEnv("staging", { CLOUDFLARE_ACCOUNT_ID: "account-value" }).ignored, [], "no token is required");
  const { env: childEnv, ignored } = wranglerChildEnv("production", { CLOUDFLARE_API_TOKEN: "token-value", CF_API_TOKEN: "legacy", CLOUDFLARE_ACCOUNT_ID: "account-value", PATH: "/bin" });
  assert.deepEqual(ignored, ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]);
  assert.equal(childEnv.CLOUDFLARE_API_TOKEN, undefined, "a token would override the OAuth session");
  assert.equal(childEnv.CF_API_TOKEN, undefined);
  assert.equal(childEnv.CLOUDFLARE_ACCOUNT_ID, "account-value");
  assert.equal(childEnv.PATH, "/bin");
  assert.equal(wranglerChildEnv("local", { CLOUDFLARE_API_TOKEN: "t" }).env.CLOUDFLARE_API_TOKEN, undefined);
  const remote = createWranglerStoreClient({ env: "production", run, childEnv });
  assert.equal(await remote.get("atlas/v1/index.json"), undefined, "wrangler's missing-key message reads as undefined");
  await remote.put("atlas/v1/index.json", Buffer.from("{}"), "application/json");
  assert.deepEqual(calls[0]!.args.slice(0, 4), ["r2", "object", "get", `${PUBLISH_BUCKETS.production}/atlas/v1/index.json`]);
  assert.ok(calls[1]!.args.includes("--remote") && calls[1]!.args.includes("--content-type"));
  assert.equal(calls[1]!.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(calls[1]!.env.CLOUDFLARE_ACCOUNT_ID, "account-value");
  const local = createWranglerStoreClient({ env: "local", persistTo: "/tmp/okie-persist", run, childEnv: {} });
  await local.put("atlas/v1/index.json", Buffer.from("{}"), "application/json");
  assert.deepEqual(calls[2]!.args.slice(-3), ["--local", "--persist-to", "/tmp/okie-persist"]);
  assert.equal(calls[2]!.args[3], `${PUBLISH_BUCKETS.local}/atlas/v1/index.json`);
});

test("CLA-266 publish: an ambiguous wrangler get never reads as missing, so index.json is never overwritten from it", async () => {
  const ambiguous = [
    "✘ [ERROR] A request to the Cloudflare API (/accounts/x/r2/buckets/sourcefor-atlas/objects/atlas%2Fv1%2Findex.json) failed. Not found [code: 10006]",
    "✘ [ERROR] The specified bucket does not exist.",
    "✘ [ERROR] Authentication error [code: 10000]",
    "404 Not Found",
    "✘ [ERROR] The specified key does not exist. (and then something else)",
  ];
  for (const stderr of ambiguous) {
    const puts: string[] = [];
    const run: WranglerRunner = async args => {
      if (args[2] === "get") {
        // The manifest is genuinely missing; only the index read is ambiguous.
        if (String(args[3]).endsWith("/manifest.json")) return { code: 1, stdout: "", stderr: "✘ [ERROR] The specified key does not exist." };
        return { code: 1, stdout: "", stderr };
      }
      puts.push(String(args[3]));
      return { code: 0, stdout: "", stderr: "" };
    };
    const client = createWranglerStoreClient({ env: "staging", run, childEnv: {} });
    await assert.rejects(client.get("atlas/v1/index.json"), /wrangler r2 object get/, stderr);
    const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-ambiguous-"));
    try {
      createPublishedOperatorFixture(scanRoot);
      const built = buildPublishedVersion({ scanRoot, repo: "acme/demo", license: FIXTURE_LICENSE });
      await assert.rejects(publishBuiltVersion(built, client), /wrangler r2 object get atlas\/v1\/index\.json/);
      assert.deepEqual(puts, [], `nothing is uploaded (index.json least of all) after: ${stderr}`);
      await assert.rejects(setPublishedLatest({ repo: "acme/demo", versionId: built.versionId, client }), /wrangler r2 object get/);
    } finally { rmSync(scanRoot, { recursive: true, force: true }); }
  }
  // Exit 0 without a downloaded file is not "missing" either.
  const noFile = createWranglerStoreClient({ env: "staging", run: async () => ({ code: 0, stdout: "", stderr: "" }), childEnv: {} });
  await assert.rejects(noFile.get("atlas/v1/index.json"), /no file written/);
});

test("CLA-266 publish: licence overrides accept SPDX expressions, normalised, and nothing else", () => {
  const ok: Array<[string, string]> = [
    ["MIT", "MIT"],
    ["NOASSERTION", "NOASSERTION"],
    ["MIT AND CC-BY-4.0", "MIT AND CC-BY-4.0"],
    ["Unlicense OR MIT", "Unlicense OR MIT"],
    ["( MIT  OR Apache-2.0 )AND CC-BY-4.0", "(MIT OR Apache-2.0) AND CC-BY-4.0"],
    ["GPL-2.0-only WITH Classpath-exception-2.0", "GPL-2.0-only WITH Classpath-exception-2.0"],
    ["LicenseRef-Custom OR MIT", "LicenseRef-Custom OR MIT"],
    ["( (MIT) )", "((MIT))"],
  ];
  for (const [raw, want] of ok) assert.equal(normalizeSpdxLicenseOverride(raw), want, raw);
  for (const bad of [
    "", "   ", "MIT and Apache-2.0", "MIT OR", "AND MIT", "MIT AND AND Apache-2.0", "(MIT", "MIT)", "()",
    "MIT WITH", "MIT WITH Apache-2.0 WITH Foo", "NOASSERTION OR MIT", "MIT; rm -rf", "MIT <b>", "MIT/Apache-2.0",
    `MIT ${"OR MIT ".repeat(40)}`,
  ]) assert.equal(normalizeSpdxLicenseOverride(bad), undefined, JSON.stringify(bad));
});

/** GitHub stand-in: the licence endpoint and `GET /repos/<o>/<r>` answered separately; every URL is recorded. */
function githubApi(repoAnswer: (url: string) => Response | Promise<Response>, urls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), null, "never an operator token");
    if (url.includes("/license?")) return new Response(JSON.stringify({ path: "LICENSE", license: { spdx_id: "MIT", name: "MIT License" } }), { status: 200 });
    return repoAnswer(url);
  }) as typeof fetch;
}
const repoJson = (login: string, name: string) => () => new Response(JSON.stringify({ name, owner: { login } }), { status: 200 });

test("CLA-318 publish: GitHub's owner/repo casing is recorded in the index row; a failed lookup still publishes without it", async () => {
  const urls: string[] = [];
  assert.deepEqual(await resolveGithubRepositoryNames({ owner: "burntsushi", repo: "ripgrep", fetch: githubApi(repoJson("BurntSushi", "ripgrep"), urls) }), { ok: true, ownerLogin: "BurntSushi", repoName: "ripgrep" });
  assert.equal(urls[0], "https://api.github.com/repos/burntsushi/ripgrep");
  // Anything off is a reason, never a throw.
  const reason = async (answer: () => Response | Promise<Response>) => {
    const result = await resolveGithubRepositoryNames({ owner: "burntsushi", repo: "ripgrep", fetch: githubApi(answer) });
    assert.equal(result.ok, false);
    return (result as { reason: string }).reason;
  };
  assert.match(await reason(() => new Response("{}", { status: 404 })), /HTTP 404/);
  assert.match(await reason(() => new Response("{}", { status: 403 })), /HTTP 403/);
  assert.match(await reason(() => new Response("not json", { status: 200 })), /invalid JSON/);
  assert.match(await reason(() => new Response(JSON.stringify({ name: "ripgrep" }), { status: 200 })), /no usable/);
  assert.match(await reason(() => new Response(JSON.stringify({ name: "rip grep", owner: { login: "BurntSushi" } }), { status: 200 })), /no usable/);
  assert.match(await reason(repoJson("SomeoneElse", "ripgrep")), /renamed or transferred/);
  assert.match(await reason(() => { throw new Error("offline"); }), /lookup failed \(offline\)/);
  assert.match((await resolveGithubRepositoryNames({ owner: "../x", repo: "y", fetch: githubApi(repoJson("x", "y")) }) as { reason: string }).reason, /cannot be looked up/);

  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-names-"));
  try {
    createPublishedOperatorFixture(scanRoot);
    const built = await preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: githubApi(repoJson("Acme", "Demo")) });
    assert.deepEqual(built.githubNames, { ok: true, ownerLogin: "Acme", repoName: "Demo" });
    assert.equal(built.indexEntry.owner, "acme");
    assert.equal(built.indexEntry.ownerLogin, "Acme");
    assert.equal(built.indexEntry.repoName, "Demo");
    assert.equal(built.slug, FIXTURE_SLUG, "slugs never use GitHub's casing");
    assert.equal("ownerLogin" in built.manifest, false, "the immutable manifest is unchanged (re-publishing a version stays byte-identical)");
    const client = memoryStoreClient();
    await publishBuiltVersion(built, client);
    const row = (JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos[0]!;
    assert.deepEqual([row.owner, row.repo, row.ownerLogin, row.repoName], ["acme", "demo", "Acme", "Demo"]);

    // Lookup failure: the publish goes ahead, and the row keeps the names it already had.
    const failed = await preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: githubApi(() => new Response("{}", { status: 500 })) });
    assert.equal(failed.githubNames?.ok, false);
    assert.equal("ownerLogin" in failed.indexEntry, false);
    await publishBuiltVersion(failed, client);
    const kept = (JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos[0]!;
    assert.deepEqual([kept.ownerLogin, kept.repoName], ["Acme", "Demo"]);
    // ...and so does a --set-latest row rebuilt from the manifest alone.
    await setPublishedLatest({ repo: "acme/demo", versionId: built.versionId, client });
    const rolled = (JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos[0]!;
    assert.deepEqual([rolled.ownerLogin, rolled.repoName], ["Acme", "Demo"]);
    // With no earlier row the failed lookup simply leaves the fields out.
    const fresh = memoryStoreClient();
    await publishBuiltVersion(failed, fresh);
    const bare = (JSON.parse(fresh.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos[0]!;
    assert.equal("ownerLogin" in bare, false);
    // The licence is still the only hard refusal.
    await assert.rejects(preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: async () => new Response("{}", { status: 404 }) }), /refusing to publish/);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-318 publish: --backfill-names fills missing names in index.json only; idempotent; dry run writes nothing; failures leave rows", async () => {
  const row = (slug: string, owner: string, repo: string, extra: Record<string, unknown> = {}) => ({ slug, owner, repo, repositoryId: `repo:${slug}`, versionId: "v1", commitSha: FIXTURE_COMMIT, generatedAt: "g", entityCount: 1, publishedAt: "2026-09-30T00:00:00.000Z", license: FIXTURE_LICENSE, ...extra });
  const original = {
    schema: "okie.published-index/v1",
    schemaVersion: 1,
    repos: [
      row("burnt-sushi__ripgrep", "burntsushi", "ripgrep"),
      row("gone__repo", "gone", "repo"),
      row("pmndrs__zustand", "pmndrs", "zustand", { ownerLogin: "pmndrs", repoName: "zustand" }),
    ],
  };
  const client = memoryStoreClient();
  client.objects.set(publishedIndexKey(), Buffer.from(`${JSON.stringify(original, null, 2)}\n`));
  const urls: string[] = [];
  const fetchImpl = githubApi(url => url.endsWith("/burntsushi/ripgrep") ? repoJson("BurntSushi", "ripgrep")() : new Response("{}", { status: 404 }), urls);

  const dry = await backfillPublishedNames({ client, write: false, fetch: fetchImpl });
  assert.deepEqual(dry.lines, [
    "gone__repo: unchanged (GitHub answered HTTP 404)",
    "pmndrs__zustand: already pmndrs/zustand",
    "burnt-sushi__ripgrep: burntsushi/ripgrep → BurntSushi/ripgrep (dry run)",
  ]);
  assert.equal(dry.wrote, false);
  assert.deepEqual(client.order, [], "a dry run writes nothing");
  assert.deepEqual(urls, ["https://api.github.com/repos/burntsushi/ripgrep", "https://api.github.com/repos/gone/repo"], "rows that already have names are not looked up");

  const first = await backfillPublishedNames({ client, write: true, fetch: fetchImpl });
  assert.deepEqual([first.filled, first.alreadySet, first.failed, first.wrote], [1, 1, 1, true]);
  assert.deepEqual(client.order, [publishedIndexKey()], "only index.json is written: no version, pointer or manifest");
  const after = JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as typeof original & { repos: Array<Record<string, unknown>> };
  assert.deepEqual(after.repos[0], { ...original.repos[0], ownerLogin: "BurntSushi", repoName: "ripgrep" });
  assert.deepEqual(after.repos[1], original.repos[1], "a failed lookup leaves its row untouched");
  assert.deepEqual(after.repos[2], original.repos[2]);
  assert.equal(after.schema, original.schema);

  // Idempotent: the second run looks up only the still-missing row and, with nothing new, does not rewrite.
  client.order.length = 0;
  urls.length = 0;
  const second = await backfillPublishedNames({ client, write: true, fetch: fetchImpl });
  assert.deepEqual([second.filled, second.alreadySet, second.failed, second.wrote], [0, 2, 1, false]);
  assert.deepEqual(urls, ["https://api.github.com/repos/gone/repo"]);
  assert.deepEqual(client.order, []);

  // No index: nothing to do; a foreign index.json is refused, never rewritten.
  assert.deepEqual((await backfillPublishedNames({ client: memoryStoreClient(), write: true, fetch: fetchImpl })).lines, ["no index.json in this store; nothing to backfill"]);
  const foreign = memoryStoreClient();
  foreign.objects.set(publishedIndexKey(), Buffer.from("{\"repos\":[]}"));
  await assert.rejects(backfillPublishedNames({ client: foreign, write: true, fetch: fetchImpl }), /not a published index/);
  assert.deepEqual(foreign.order, []);
});

test("CLA-318 publish: --backfill-names re-reads index.json before writing, so a publish during the lookups is kept", async () => {
  const row = (slug: string, owner: string, repo: string, extra: Record<string, unknown> = {}) => ({ slug, owner, repo, repositoryId: `repo:${slug}`, versionId: "v1", commitSha: FIXTURE_COMMIT, generatedAt: "g", entityCount: 1, publishedAt: "2026-09-30T00:00:00.000Z", license: FIXTURE_LICENSE, ...extra });
  const indexOf = (repos: unknown[]) => Buffer.from(`${JSON.stringify({ schema: "okie.published-index/v1", schemaVersion: 1, repos }, null, 2)}\n`);
  const client = memoryStoreClient();
  client.objects.set(publishedIndexKey(), indexOf([
    row("burnt-sushi__ripgrep", "burntsushi", "ripgrep"),
    row("sharkdp__bat", "sharkdp", "bat"),
    row("sharkdp__fd", "sharkdp", "fd"),
  ]));
  // While GitHub is being asked, a concurrent publish lands: a new version of ripgrep, a brand-new atlas, bat re-published
  // under a different owner spelling, and fd gains names from a newer publish.
  let lookups = 0;
  const fetchImpl = githubApi(url => {
    lookups += 1;
    if (lookups === 1) {
      client.objects.set(publishedIndexKey(), indexOf([
        row("burnt-sushi__ripgrep", "burntsushi", "ripgrep", { versionId: "v2" }),
        row("new__atlas", "new", "atlas"),
        row("sharkdp__bat", "SharkDP", "bat"),
        row("sharkdp__fd", "sharkdp", "fd", { ownerLogin: "sharkdp", repoName: "fd", versionId: "v9" }),
      ]));
    }
    const [, owner, repo] = /repos\/([^/]+)\/([^/]+)$/.exec(url)!;
    return repoJson(owner === "burntsushi" ? "BurntSushi" : owner!, repo!)();
  });
  const result = await backfillPublishedNames({ client, write: true, fetch: fetchImpl });
  assert.equal(result.wrote, true);
  assert.equal(result.filled, 1);
  const after = JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> };
  assert.deepEqual(after.repos.map(value => value.slug), ["burnt-sushi__ripgrep", "new__atlas", "sharkdp__bat", "sharkdp__fd"], "the concurrently published row is kept");
  assert.deepEqual(after.repos[0], { ...row("burnt-sushi__ripgrep", "burntsushi", "ripgrep", { versionId: "v2" }), ownerLogin: "BurntSushi", repoName: "ripgrep" }, "names land on the fresh row (new version kept)");
  assert.equal("ownerLogin" in after.repos[1]!, false, "a row that was never looked up is untouched");
  assert.equal("ownerLogin" in after.repos[2]!, false, "a row whose owner changed is not given stale names");
  assert.equal(after.repos[3]!.versionId, "v9", "a row that gained names meanwhile is kept as is");
  assert.ok(result.lines.includes("sharkdp__bat: skipped (the row changed or gained names during the backfill)"));
  assert.ok(result.lines.includes("sharkdp__fd: skipped (the row changed or gained names during the backfill)"));
});
