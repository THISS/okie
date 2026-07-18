import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildScanManifest, manifestEntryFromSnapshot, regenerateScanManifest, type ScanManifestEntry } from "./manifest.js";

const entry = (slug: string, sha = "abc", n = 3): ScanManifestEntry => ({
  slug,
  repositoryId: `repo:${slug}`,
  commitSha: sha,
  generatedAt: "2024-01-01T00:00:00.000Z",
  entityCount: n,
});

test("buildScanManifest sorts by slug and dedupes (last write wins) — order-independent bytes", () => {
  const forward = buildScanManifest([entry("colinhacks__zod"), entry("acme__app"), entry("microsoft__tslib")]);
  const shuffled = buildScanManifest([entry("microsoft__tslib"), entry("colinhacks__zod"), entry("acme__app")]);
  assert.equal(JSON.stringify(forward), JSON.stringify(shuffled), "manifest bytes independent of input order");
  assert.deepEqual(forward.repos.map(r => r.slug), ["acme__app", "colinhacks__zod", "microsoft__tslib"]);
  assert.equal(forward.schemaVersion, 1);

  const deduped = buildScanManifest([entry("acme__app", "old", 1), entry("acme__app", "new", 9)]);
  assert.equal(deduped.repos.length, 1);
  assert.equal(deduped.repos[0]!.commitSha, "new");
  assert.equal(deduped.repos[0]!.entityCount, 9);
});

test("manifestEntryFromSnapshot pulls identity fields; rejects a non-scan snapshot", () => {
  const ok = manifestEntryFromSnapshot("o__r", {
    repositoryId: "repo:o-r",
    commitSha: "deadbeef",
    generatedAt: "2024-02-02T02:02:02.000Z",
    entities: [{ id: "a" }, { id: "b" }],
  });
  assert.deepEqual(ok, { slug: "o__r", repositoryId: "repo:o-r", commitSha: "deadbeef", generatedAt: "2024-02-02T02:02:02.000Z", entityCount: 2 });

  assert.equal(manifestEntryFromSnapshot("o__r", { repositoryId: "repo:o-r" }), undefined, "missing commitSha/generatedAt/entities");
  assert.equal(manifestEntryFromSnapshot("o__r", "not-json-object"), undefined);
});

test("regenerateScanManifest indexes per-repo slots deterministically, ignores the root trio", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-manifest-"));
  try {
    const writeSnapshot = (slug: string, sha: string, entities: number) => {
      mkdirSync(join(scanRoot, slug), { recursive: true });
      writeFileSync(join(scanRoot, slug, "snapshot.json"), JSON.stringify({
        repositoryId: `repo:${slug}`, commitSha: sha, generatedAt: "2024-03-03T03:03:03.000Z",
        entities: Array.from({ length: entities }, (_v, i) => ({ id: `e${i}` })),
      }));
    };
    writeSnapshot("beta__two", "sha-b", 5);
    writeSnapshot("alpha__one", "sha-a", 2);
    // The Okie self-scan root trio lives directly under scanRoot — it must NOT be indexed.
    writeFileSync(join(scanRoot, "snapshot.json"), JSON.stringify({ repositoryId: "repo:okie", commitSha: "root", generatedAt: "x", entities: [] }));
    // A stray directory without a snapshot is skipped, not fatal.
    mkdirSync(join(scanRoot, "empty-dir"), { recursive: true });

    const manifest = regenerateScanManifest(scanRoot);
    assert.deepEqual(manifest.repos.map(r => r.slug), ["alpha__one", "beta__two"]);
    assert.equal(manifest.repos[0]!.commitSha, "sha-a");
    assert.equal(manifest.repos[1]!.entityCount, 5);

    // Regenerating over the same disk state is byte-identical.
    assert.equal(JSON.stringify(regenerateScanManifest(scanRoot)), JSON.stringify(manifest));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("regenerateScanManifest on a missing directory yields an empty manifest", () => {
  const manifest = regenerateScanManifest(join(tmpdir(), "okie-scan-does-not-exist-xyz"));
  assert.deepEqual(manifest, { schemaVersion: 1, repos: [] });
});
