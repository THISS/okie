import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  backfillBackupPath,
  backfillPublishedMeta,
  backfillPublishedNames,
  buildPublishedVersion,
  fileIndexBackup,
  readOnlyStoreClient,
  createDirectoryStoreClient,
  createWranglerStoreClient,
  gzipMember,
  normalizeSpdxLicenseOverride,
  preparePublishedVersion,
  PUBLISH_BUCKETS,
  publishBuiltVersion,
  resolveGithubRepositoryNames,
  resolvePublishedLicense,
  sanitizeGithubText,
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

const repoJsonWith = (login: string, name: string, extra: Record<string, unknown>) => () => new Response(JSON.stringify({ name, owner: { login }, ...extra }), { status: 200 });

test("CLA-269 publish: GitHub's description and language are sanitised onto the index row, refreshed on re-publish, kept on a failed lookup", async () => {
  // Sanitising: trimmed, one line, no control/bidi/zero-width characters, capped with an ellipsis; empty → absent.
  assert.equal(sanitizeGithubText("  A fast\n\tgrep \u202Etool\u200B\u0007 ", 280), "A fast grep tool");
  assert.equal(sanitizeGithubText("\u0085x\u009f", 280), "x");
  assert.equal(sanitizeGithubText("   ", 280), undefined);
  assert.equal(sanitizeGithubText(null, 280), undefined);
  assert.equal(sanitizeGithubText(42, 280), undefined);
  const long = sanitizeGithubText(`🐻 ${"word ".repeat(100)}`, 280)!;
  assert.equal(Array.from(long).length, 280);
  assert.ok(long.endsWith("…"));
  assert.equal(sanitizeGithubText(long, 280), long, "idempotent");
  assert.equal(Array.from(sanitizeGithubText("L".repeat(60), 40)!).length, 40);

  assert.deepEqual(
    await resolveGithubRepositoryNames({ owner: "pmndrs", repo: "zustand", fetch: githubApi(repoJsonWith("pmndrs", "zustand", { description: " 🐻 Bear necessities for state management in React ", language: "TypeScript" })) }),
    { ok: true, ownerLogin: "pmndrs", repoName: "zustand", description: "🐻 Bear necessities for state management in React", language: "TypeScript" },
  );
  assert.deepEqual(
    await resolveGithubRepositoryNames({ owner: "pmndrs", repo: "zustand", fetch: githubApi(repoJsonWith("pmndrs", "zustand", { description: null, language: "" })) }),
    { ok: true, ownerLogin: "pmndrs", repoName: "zustand", description: null, language: null },
    "null and empty are reported as null (GitHub has none)",
  );
  assert.deepEqual(
    await resolveGithubRepositoryNames({ owner: "pmndrs", repo: "zustand", fetch: githubApi(repoJsonWith("pmndrs", "zustand", {})) }),
    { ok: true, ownerLogin: "pmndrs", repoName: "zustand" },
    "keys the response lacks are left out (the stored values are kept)",
  );

  const scanRoot = mkdtempSync(join(tmpdir(), "okie-publish-meta-"));
  try {
    createPublishedOperatorFixture(scanRoot);
    const rowOf = (client: ReturnType<typeof memoryStoreClient>) => (JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos[0]!;
    const client = memoryStoreClient();
    const built = await preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: githubApi(repoJsonWith("Acme", "Demo", { description: "Demo <app> for\ntests", language: "Rust" })) });
    assert.equal(built.indexEntry.description, "Demo <app> for tests");
    assert.equal(built.indexEntry.language, "Rust");
    assert.equal("description" in built.manifest, false, "the immutable manifest is unchanged");
    await publishBuiltVersion(built, client);
    assert.deepEqual([rowOf(client).description, rowOf(client).language], ["Demo <app> for tests", "Rust"]);

    // A failed lookup keeps the recorded description/language with the names; so does --set-latest.
    const failed = await preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: githubApi(() => new Response("{}", { status: 500 })) });
    await publishBuiltVersion(failed, client);
    assert.deepEqual([rowOf(client).ownerLogin, rowOf(client).description, rowOf(client).language], ["Acme", "Demo <app> for tests", "Rust"]);
    await setPublishedLatest({ repo: "acme/demo", versionId: built.versionId, client });
    assert.deepEqual([rowOf(client).description, rowOf(client).language], ["Demo <app> for tests", "Rust"]);

    // A successful lookup refreshes them: a new description replaces the old; a language GitHub no longer reports goes.
    const refreshed = await preparePublishedVersion({ scanRoot, repo: "acme/demo", fetch: githubApi(repoJsonWith("Acme", "Demo", { description: "Now with docs", language: null })) });
    await publishBuiltVersion(refreshed, client);
    assert.equal(rowOf(client).description, "Now with docs");
    assert.equal("language" in rowOf(client), false);
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-269 publish: --backfill-meta fills and refreshes description/language (and names) in index.json only, with a backup before the write", async () => {
  const row = (slug: string, owner: string, repo: string, extra: Record<string, unknown> = {}) => ({ slug, owner, repo, repositoryId: `repo:${slug}`, versionId: "v1", commitSha: FIXTURE_COMMIT, generatedAt: "g", entityCount: 1, publishedAt: "2026-09-30T00:00:00.000Z", license: FIXTURE_LICENSE, ...extra });
  const original = {
    schema: "okie.published-index/v1",
    schemaVersion: 1,
    extra: "kept",
    repos: [
      // No names, no meta: gets all four.
      row("burnt-sushi__ripgrep", "burntsushi", "ripgrep"),
      // Lookup fails: untouched.
      row("gone__repo", "gone", "repo"),
      // Names already, stale description, language GitHub no longer reports.
      row("pmndrs__zustand", "pmndrs", "zustand", { ownerLogin: "pmndrs", repoName: "zustand", description: "old", language: "JavaScript" }),
      // Already matches GitHub: no change.
      row("sharkdp__bat", "sharkdp", "bat", { ownerLogin: "sharkdp", repoName: "bat", description: "A cat(1) clone with wings.", language: "Rust" }),
    ],
  };
  const answers: Record<string, () => Response> = {
    "/burntsushi/ripgrep": repoJsonWith("BurntSushi", "ripgrep", { description: "ripgrep recursively searches directories for a regex pattern\u202E ", language: "Rust" }),
    "/pmndrs/zustand": repoJsonWith("pmndrs", "zustand", { description: "🐻 Bear necessities", language: null }),
    "/sharkdp/bat": repoJsonWith("sharkdp", "bat", { description: "A cat(1) clone with wings.", language: "Rust" }),
  };
  const urls: string[] = [];
  const fetchImpl = githubApi(url => answers[url.slice(url.indexOf("/repos") + "/repos".length)]?.() ?? new Response("{}", { status: 404 }), urls);
  const client = memoryStoreClient();
  const originalBytes = Buffer.from(`${JSON.stringify(original, null, 2)}\n`);
  client.objects.set(publishedIndexKey(), originalBytes);
  const backups: Buffer[] = [];
  const backup = (bytes: Buffer) => { backups.push(Buffer.from(bytes)); return `/backups/${backups.length}.json`; };

  const dry = await backfillPublishedMeta({ client, write: false, fetch: fetchImpl, backup });
  assert.deepEqual(dry.lines, [
    "gone__repo: unchanged (GitHub answered HTTP 404)",
    "sharkdp__bat: up to date",
    "burnt-sushi__ripgrep: names → BurntSushi/ripgrep, description added (60 chars), language → Rust (dry run)",
    "pmndrs__zustand: description refreshed (18 chars), language removed (dry run)",
  ]);
  assert.deepEqual([dry.updated, dry.upToDate, dry.failed, dry.skipped, dry.wrote], [2, 1, 1, 0, false]);
  assert.deepEqual(client.order, [], "a dry run writes nothing");
  assert.equal(backups.length, 0, "and backs nothing up");
  assert.equal(urls.length, 4, "every row is looked up (refresh), names or not");

  const first = await backfillPublishedMeta({ client, write: true, fetch: fetchImpl, backup });
  assert.deepEqual([first.updated, first.upToDate, first.failed, first.skipped, first.wrote], [2, 1, 1, 0, true]);
  assert.deepEqual(client.order, [publishedIndexKey()], "only index.json is written: no version, pointer or manifest");
  assert.equal(backups.length, 1);
  assert.ok(backups[0]!.equals(originalBytes), "the backup holds the exact bytes that were overwritten");
  assert.equal(first.backupPath, "/backups/1.json");
  assert.ok(first.lines.includes("backup of the current index.json (" + originalBytes.byteLength + " bytes) saved to /backups/1.json"));
  const after = JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as typeof original & { repos: Array<Record<string, unknown>> };
  assert.equal(after.extra, "kept");
  assert.deepEqual(after.repos[0], { ...original.repos[0], ownerLogin: "BurntSushi", repoName: "ripgrep", description: "ripgrep recursively searches directories for a regex pattern", language: "Rust" });
  assert.deepEqual(after.repos[1], original.repos[1], "a failed lookup leaves its row untouched");
  assert.deepEqual(after.repos[2], { ...row("pmndrs__zustand", "pmndrs", "zustand"), ownerLogin: "pmndrs", repoName: "zustand", description: "🐻 Bear necessities" });
  assert.deepEqual(after.repos[3], original.repos[3]);

  // Idempotent: a second run looks everything up again but, with nothing new, neither backs up nor writes.
  client.order.length = 0;
  const second = await backfillPublishedMeta({ client, write: true, fetch: fetchImpl, backup });
  assert.deepEqual([second.updated, second.upToDate, second.failed, second.wrote], [0, 3, 1, false]);
  assert.deepEqual(client.order, []);
  assert.equal(backups.length, 1);

  // A failing backup stops the write.
  const blocked = memoryStoreClient();
  blocked.objects.set(publishedIndexKey(), originalBytes);
  await assert.rejects(backfillPublishedMeta({ client: blocked, write: true, fetch: fetchImpl, backup: () => { throw new Error("disk full"); } }), /disk full/);
  assert.deepEqual(blocked.order, []);

  // No index: nothing to do; a foreign index.json is refused, never rewritten.
  assert.deepEqual((await backfillPublishedMeta({ client: memoryStoreClient(), write: true, fetch: fetchImpl })).lines, ["no index.json in this store; nothing to backfill"]);
  const foreign = memoryStoreClient();
  foreign.objects.set(publishedIndexKey(), Buffer.from("{\"repos\":[]}"));
  await assert.rejects(backfillPublishedMeta({ client: foreign, write: true, fetch: fetchImpl }), /not a published index/);
  assert.deepEqual(foreign.order, []);
});

test("CLA-269 publish: --backfill-meta re-reads index.json before writing and skips any row that changed during the lookups", async () => {
  const row = (slug: string, owner: string, repo: string, extra: Record<string, unknown> = {}) => ({ slug, owner, repo, repositoryId: `repo:${slug}`, versionId: "v1", commitSha: FIXTURE_COMMIT, generatedAt: "g", entityCount: 1, publishedAt: "2026-09-30T00:00:00.000Z", license: FIXTURE_LICENSE, ...extra });
  const indexOf = (repos: unknown[]) => Buffer.from(`${JSON.stringify({ schema: "okie.published-index/v1", schemaVersion: 1, repos }, null, 2)}\n`);
  const client = memoryStoreClient();
  client.objects.set(publishedIndexKey(), indexOf([
    row("burnt-sushi__ripgrep", "burntsushi", "ripgrep"),
    row("sharkdp__bat", "sharkdp", "bat"),
    row("sharkdp__fd", "sharkdp", "fd"),
  ]));
  // During the lookups a publish lands: ripgrep gets a new version, a brand-new atlas appears, fd gains a description.
  let lookups = 0;
  const concurrent = indexOf([
    row("burnt-sushi__ripgrep", "burntsushi", "ripgrep", { versionId: "v2" }),
    row("new__atlas", "new", "atlas"),
    row("sharkdp__bat", "sharkdp", "bat"),
    row("sharkdp__fd", "sharkdp", "fd", { ownerLogin: "sharkdp", repoName: "fd", description: "newer", versionId: "v9" }),
  ]);
  const fetchImpl = githubApi(url => {
    lookups += 1;
    if (lookups === 1) client.objects.set(publishedIndexKey(), concurrent);
    const [, owner, repo] = /repos\/([^/]+)\/([^/]+)$/.exec(url)!;
    return repoJsonWith(owner === "burntsushi" ? "BurntSushi" : owner!, repo!, { description: `about ${repo}`, language: "Rust" })();
  });
  const backups: Buffer[] = [];
  const result = await backfillPublishedMeta({ client, write: true, fetch: fetchImpl, backup: bytes => { backups.push(Buffer.from(bytes)); return "/b.json"; } });
  assert.equal(result.wrote, true);
  assert.deepEqual([result.updated, result.skipped], [1, 2]);
  assert.ok(backups[0]!.equals(concurrent), "the backup is of the index as re-read for the write");
  const after = JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> };
  assert.deepEqual(after.repos.map(value => value.slug), ["burnt-sushi__ripgrep", "new__atlas", "sharkdp__bat", "sharkdp__fd"], "the concurrently published row is kept");
  assert.equal(after.repos[0]!.versionId, "v2");
  assert.equal("description" in after.repos[0]!, false, "a row that changed is not given stale data");
  assert.equal("description" in after.repos[1]!, false, "a row that was never looked up is untouched");
  assert.deepEqual([after.repos[2]!.description, after.repos[2]!.language, after.repos[2]!.ownerLogin], ["about bat", "Rust", "sharkdp"]);
  assert.equal(after.repos[3]!.description, "newer");
  assert.ok(result.lines.includes("burnt-sushi__ripgrep: skipped (the row changed during the backfill)"));
  assert.ok(result.lines.includes("sharkdp__fd: skipped (the row changed during the backfill)"));
});

test("CLA-269 publish: --backfill-names backs up index.json before its write too, and records the meta from the same response", async () => {
  const row = { slug: "pmndrs__zustand", owner: "pmndrs", repo: "zustand", repositoryId: "repo:x", versionId: "v1", commitSha: FIXTURE_COMMIT, generatedAt: "g", entityCount: 1, publishedAt: "2026-09-30T00:00:00.000Z", license: FIXTURE_LICENSE };
  const bytes = Buffer.from(`${JSON.stringify({ schema: "okie.published-index/v1", schemaVersion: 1, repos: [row] }, null, 2)}\n`);
  const client = memoryStoreClient();
  client.objects.set(publishedIndexKey(), bytes);
  const backups: Buffer[] = [];
  const result = await backfillPublishedNames({ client, write: true, fetch: githubApi(repoJsonWith("pmndrs", "zustand", { description: "Bears", language: "TypeScript" })), backup: value => { backups.push(Buffer.from(value)); return "/n.json"; } });
  assert.equal(result.backupPath, "/n.json");
  assert.ok(backups[0]!.equals(bytes));
  const after = (JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos[0]!;
  assert.deepEqual(after, { ...row, ownerLogin: "pmndrs", repoName: "zustand", description: "Bears", language: "TypeScript" });
});

const MAGE = "\u{1F9D9}\u200D♀️";
const metaRow = (slug: string, owner: string, repo: string, extra: Record<string, unknown> = {}) => ({ slug, owner, repo, repositoryId: `repo:${slug}`, versionId: "v1", commitSha: FIXTURE_COMMIT, generatedAt: "g", entityCount: 1, publishedAt: "2026-09-30T00:00:00.000Z", license: FIXTURE_LICENSE, ...extra });
const indexBytes = (repos: unknown[]) => Buffer.from(`${JSON.stringify({ schema: "okie.published-index/v1", schemaVersion: 1, repos }, null, 2)}\n`);
const reposOf = (client: ReturnType<typeof memoryStoreClient>) => (JSON.parse(client.objects.get(publishedIndexKey())!.toString()) as { repos: Array<Record<string, unknown>> }).repos;

test("CLA-269 publish: zero-width joiners survive sanitising, so ZWJ emoji stay whole; other invisible characters go", () => {
  assert.equal(sanitizeGithubText(`${MAGE} Move fast and break nothing`, 280), `${MAGE} Move fast and break nothing`);
  assert.equal(sanitizeGithubText("a\u200Cb", 280), "a\u200Cb");
  assert.equal(sanitizeGithubText("\u200Bx\u200Ey\u200F\u202Az\u202E\u2066w\u2069\uFEFF", 280), "xyzw");
});

test("CLA-269 publish: --backfill-meta keeps a stored description/language the GitHub response does not mention", async () => {
  const client = memoryStoreClient();
  client.objects.set(publishedIndexKey(), indexBytes([
    metaRow("pmndrs__zustand", "pmndrs", "zustand", { ownerLogin: "pmndrs", repoName: "zustand", description: "Bears", language: "TypeScript" }),
    metaRow("sharkdp__bat", "sharkdp", "bat", { ownerLogin: "sharkdp", repoName: "bat", description: "old", language: "Rust" }),
  ]));
  const answers: Record<string, () => Response> = {
    // No description/language keys at all: both kept.
    "zustand": repoJsonWith("pmndrs", "zustand", {}),
    // Description null (removed), language key missing (kept).
    "bat": repoJsonWith("sharkdp", "bat", { description: null }),
  };
  const result = await backfillPublishedMeta({ client, write: true, fetch: githubApi(url => answers[url.slice(url.lastIndexOf("/") + 1)]!()) });
  assert.deepEqual([result.updated, result.upToDate], [1, 1]);
  const [zustand, bat] = reposOf(client);
  assert.deepEqual([zustand!.description, zustand!.language], ["Bears", "TypeScript"]);
  assert.equal("description" in bat!, false);
  assert.equal(bat!.language, "Rust");
});

test("CLA-269 publish: --backfill-meta treats a key-order difference as up to date (no rewrite, no empty line)", async () => {
  const client = memoryStoreClient();
  // Meta keys before the names: stringified differently, but nothing to change.
  const row = { description: "Bears", language: "TypeScript", ...metaRow("pmndrs__zustand", "pmndrs", "zustand", { ownerLogin: "pmndrs", repoName: "zustand" }) };
  client.objects.set(publishedIndexKey(), indexBytes([row]));
  const result = await backfillPublishedMeta({ client, write: true, fetch: githubApi(repoJsonWith("pmndrs", "zustand", { description: "Bears", language: "TypeScript" })), backup: () => { throw new Error("no backup expected"); } });
  assert.deepEqual(result.lines, ["pmndrs__zustand: up to date"]);
  assert.deepEqual([result.updated, result.upToDate, result.wrote], [0, 1, false]);
  assert.deepEqual(client.order, []);
});

test("CLA-269 publish: backfills stop at GitHub's rate limit, write only what was resolved, and look up the gaps first", async () => {
  const rows = [
    // Complete rows (names + description + language) come last in the lookup order.
    metaRow("aa__complete", "aa", "complete", { ownerLogin: "aa", repoName: "complete", description: "old", language: "Go" }),
    metaRow("bb__gap", "bb", "gap"),
    metaRow("cc__nolang", "cc", "nolang", { ownerLogin: "cc", repoName: "nolang", description: "d" }),
    metaRow("dd__gap", "dd", "gap"),
  ];
  const limited = (status: number, remaining: string) => () => new Response("{}", { status, headers: { "x-ratelimit-remaining": remaining } });
  const run = async (answer: (repo: string, n: number) => Response) => {
    const client = memoryStoreClient();
    client.objects.set(publishedIndexKey(), indexBytes(rows));
    const urls: string[] = [];
    let n = 0;
    const result = await backfillPublishedMeta({ client, write: true, fetch: githubApi(url => answer(url.slice(url.indexOf("/repos/") + 7), ++n), urls) });
    return { client, result, looked: urls.map(url => url.slice(url.indexOf("/repos/") + 7)) };
  };
  const ok = (repo: string, headers: Record<string, string> = {}) => {
    const [owner, name] = repo.split("/") as [string, string];
    return new Response(JSON.stringify({ name, owner: { login: owner }, description: `about ${name}`, language: "Rust" }), { status: 200, headers });
  };

  // HTTP 403 on the second lookup: the first (resolved) row is written, the 403 row and the rest are not reached.
  const forbidden = await run((repo, n) => (n === 2 ? limited(403, "0")() : ok(repo)));
  assert.deepEqual(forbidden.looked, ["bb/gap", "cc/nolang"], "gaps first, then stop at the 403");
  assert.deepEqual([forbidden.result.updated, forbidden.result.failed, forbidden.result.notReached, forbidden.result.wrote], [1, 0, 3, true]);
  assert.ok(forbidden.result.lines.includes("stopped looking up at GitHub's rate limit (GitHub answered HTTP 403): 3 rows not reached, left as they are; re-run after the limit resets"));
  const afterForbidden = reposOf(forbidden.client);
  assert.equal(afterForbidden.find(row => row.slug === "bb__gap")!.description, "about gap");
  assert.equal(afterForbidden.find(row => row.slug === "cc__nolang")!.language, undefined);
  assert.equal(afterForbidden.find(row => row.slug === "aa__complete")!.description, "old");

  // HTTP 429 on the first lookup: nothing resolved, nothing written.
  const tooMany = await run(() => limited(429, "10")());
  assert.deepEqual(tooMany.looked, ["bb/gap"]);
  assert.deepEqual([tooMany.result.notReached, tooMany.result.wrote], [4, false]);
  assert.deepEqual(tooMany.client.order, []);

  // A success with `x-ratelimit-remaining: 0` is used, then the lookups stop.
  const lastOne = await run(repo => ok(repo, { "x-ratelimit-remaining": "0" }));
  assert.deepEqual(lastOne.looked, ["bb/gap"]);
  assert.deepEqual([lastOne.result.updated, lastOne.result.notReached, lastOne.result.wrote], [1, 3, true]);
  assert.ok(lastOne.result.lines.includes("stopped looking up at GitHub's rate limit (x-ratelimit-remaining is 0): 3 rows not reached, left as they are; re-run after the limit resets"));

  // Other failures (404) do not stop the run.
  const notFound = await run((repo, n) => (n === 1 ? new Response("{}", { status: 404 }) : ok(repo)));
  assert.equal(notFound.looked.length, 4);
  assert.deepEqual([notFound.result.failed, notFound.result.notReached], [1, 0]);

  // --backfill-names stops the same way.
  const client = memoryStoreClient();
  client.objects.set(publishedIndexKey(), indexBytes(rows));
  const names = await backfillPublishedNames({ client, write: true, fetch: githubApi(url => (url.endsWith("/bb/gap") ? ok("bb/gap") : limited(403, "0")())) });
  assert.deepEqual([names.filled, names.alreadySet, names.notReached, names.failed, names.wrote], [1, 2, 1, 0, true]);
  assert.equal(reposOf(client).find(row => row.slug === "bb__gap")!.ownerLogin, "bb");
  assert.equal(reposOf(client).find(row => row.slug === "dd__gap")!.ownerLogin, undefined);
});

test("CLA-269 publish: after the write a backfill reads index.json back and warns loudly, naming the backup, when it differs", async () => {
  const bytes = indexBytes([metaRow("pmndrs__zustand", "pmndrs", "zustand")]);
  const store = memoryStoreClient();
  store.objects.set(publishedIndexKey(), bytes);
  // A publish lands right after the backfill's put.
  const racing: PublishStoreClient = {
    get: key => store.get(key),
    async put(key, value, type) {
      await store.put(key, value, type);
      store.objects.set(publishedIndexKey(), indexBytes([metaRow("new__atlas", "new", "atlas")]));
    },
  };
  const result = await backfillPublishedMeta({ client: racing, write: true, fetch: githubApi(repoJsonWith("pmndrs", "zustand", { description: "Bears", language: "TypeScript" })), backup: () => "/tmp/backup.json" });
  assert.equal(result.wrote, true);
  assert.equal(result.verified, false);
  const warning = result.lines.find(line => line.startsWith("WARNING:"));
  assert.ok(warning, "a WARNING line");
  assert.match(warning!, /may have been overwritten/);
  assert.match(warning!, /\/tmp\/backup\.json/);

  // Without a race the read-back matches.
  const calm = memoryStoreClient();
  calm.objects.set(publishedIndexKey(), bytes);
  const ok = await backfillPublishedNames({ client: calm, write: true, fetch: githubApi(repoJsonWith("pmndrs", "zustand", {})) });
  assert.deepEqual([ok.wrote, ok.verified], [true, true]);
  assert.equal(ok.lines.some(line => line.startsWith("WARNING:")), false);
});

test("CLA-269 publish: a dry-run backfill runs on a read-only client, which refuses every write", async () => {
  const store = memoryStoreClient();
  store.objects.set(publishedIndexKey(), indexBytes([metaRow("pmndrs__zustand", "pmndrs", "zustand")]));
  const readOnly = readOnlyStoreClient(store);
  assert.deepEqual(await readOnly.get(publishedIndexKey()), store.objects.get(publishedIndexKey()));
  await assert.rejects(readOnly.put(publishedIndexKey(), Buffer.from("{}"), "application/json"), /dry run: refusing to put atlas\/v1\/index\.json/);
  await assert.rejects(readOnly.delete(publishedIndexKey()), /dry run: refusing to delete/);
  assert.deepEqual(store.order, []);

  // The backfill wraps the client itself on a dry run: a client that would write never sees a put, and a backup is never made.
  const puts: string[] = [];
  const writable: PublishStoreClient = { get: key => store.get(key), async put(key) { puts.push(key); } };
  const fetchImpl = githubApi(repoJsonWith("pmndrs", "zustand", { description: "Bears", language: "TypeScript" }));
  const noBackup = () => { throw new Error("a dry run backs nothing up"); };
  const meta = await backfillPublishedMeta({ client: writable, write: false, fetch: fetchImpl, backup: noBackup });
  const names = await backfillPublishedNames({ client: writable, write: false, fetch: fetchImpl, backup: noBackup });
  assert.deepEqual([meta.updated, meta.wrote, names.filled, names.wrote], [1, false, 1, false]);
  assert.deepEqual(puts, []);
});

test("CLA-269 publish: backfill backups resolve against the invoking directory, sit beside --out, never overwrite, and are read back", () => {
  const now = new Date("2026-09-30T01:02:03.456Z");
  assert.equal(backfillBackupPath({ env: "staging", base: "/home/me/work", now }), "/home/me/work/backfill-backup-staging-2026-09-30T01-02-03-456Z.json");
  assert.equal(backfillBackupPath({ env: "staging", base: "/home/me/work", backup: "b/x.json", now }), "/home/me/work/b/x.json");
  assert.equal(backfillBackupPath({ env: "staging", base: "/home/me/work", backup: "/abs/x.json", now }), "/abs/x.json");
  // Beside the --out directory store, not inside it.
  assert.equal(backfillBackupPath({ env: "local", base: "/home/me/work", out: "/tmp/store", now }), "/tmp/backfill-backup-local-2026-09-30T01-02-03-456Z.json");
  assert.equal(backfillBackupPath({ env: "local", base: "/home/me/work", out: "dry/store", now }), "/home/me/work/dry/backfill-backup-local-2026-09-30T01-02-03-456Z.json");

  const dir = mkdtempSync(join(tmpdir(), "okie-backfill-backup-"));
  try {
    const bytes = Buffer.from("{\"schema\":\"okie.published-index/v1\"}\n");
    const backup = fileIndexBackup({ env: "local", base: dir, backup: "nested/one.json" });
    const path = backup(bytes) as string;
    assert.equal(path, join(dir, "nested/one.json"));
    assert.ok(readFileSync(path).equals(bytes));
    assert.throws(() => backup(bytes), /EEXIST/, "never overwrites an existing backup");
    const byDefault = fileIndexBackup({ env: "local", base: dir, out: join(dir, "store"), now: () => now });
    assert.equal(byDefault(bytes), join(dir, "backfill-backup-local-2026-09-30T01-02-03-456Z.json"));
    // A backup that does not read back identically throws, so the backfill aborts before its write.
    const corrupt = fileIndexBackup({ env: "local", base: dir, backup: "two.json", readBack: () => Buffer.from("{}") });
    assert.throws(() => corrupt(bytes), /does not read back as written/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLA-269 publish: a backup that does not read back aborts the backfill before any write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okie-backfill-abort-"));
  try {
    const client = memoryStoreClient();
    client.objects.set(publishedIndexKey(), indexBytes([metaRow("pmndrs__zustand", "pmndrs", "zustand")]));
    const backup = fileIndexBackup({ env: "local", base: dir, backup: "b.json", readBack: path => { writeFileSync(path, "truncated"); return readFileSync(path); } });
    await assert.rejects(backfillPublishedMeta({ client, write: true, fetch: githubApi(repoJsonWith("pmndrs", "zustand", { description: "Bears" })), backup }), /does not read back as written/);
    assert.deepEqual(client.order, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
