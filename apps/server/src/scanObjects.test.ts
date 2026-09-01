import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DOGFOOD_SCAN_SLUG, publishedScanCandidates, resolvePublishedScanFile } from "./scanObjects.js";

test("dogfood slug aliases the root self-scan trio", () => {
  assert.equal(DOGFOOD_SCAN_SLUG, "thiss__okie");
  assert.deepEqual(publishedScanCandidates("thiss__okie/snapshot.json"), [
    "thiss__okie/snapshot.json",
    "snapshot.json",
  ]);
  assert.deepEqual(publishedScanCandidates("colinhacks__zod/snapshot.json"), [
    "colinhacks__zod/snapshot.json",
  ]);
  assert.deepEqual(publishedScanCandidates("index.json"), ["index.json"]);
  assert.deepEqual(publishedScanCandidates("../secrets.env"), []);
});

test("resolvePublishedScanFile serves the THISS/okie alias from the root trio", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-objects-"));
  try {
    writeFileSync(join(scanRoot, "snapshot.json"), "{\"root\":true}");
    writeFileSync(join(scanRoot, "view.json"), "{\"root\":true}");
    mkdirSync(join(scanRoot, "acme__app"), { recursive: true });
    writeFileSync(join(scanRoot, "acme__app", "snapshot.json"), "{\"slug\":true}");

    assert.equal(
      resolvePublishedScanFile(scanRoot, "/scan/thiss__okie/snapshot.json"),
      join(scanRoot, "snapshot.json"),
    );
    assert.equal(
      resolvePublishedScanFile(scanRoot, "/scan/acme__app/snapshot.json"),
      join(scanRoot, "acme__app", "snapshot.json"),
    );
    assert.equal(resolvePublishedScanFile(scanRoot, "/scan/missing__repo/snapshot.json"), undefined);
    assert.equal(resolvePublishedScanFile(scanRoot, "/scan/../snapshot.json"), undefined);
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("a published thiss__okie slot wins over the root self-scan alias", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-objects-"));
  try {
    writeFileSync(join(scanRoot, "snapshot.json"), "{\"root\":true}");
    mkdirSync(join(scanRoot, "thiss__okie"), { recursive: true });
    writeFileSync(join(scanRoot, "thiss__okie", "snapshot.json"), "{\"hosted\":true}");
    assert.equal(
      resolvePublishedScanFile(scanRoot, "/scan/thiss__okie/snapshot.json"),
      join(scanRoot, "thiss__okie", "snapshot.json"),
    );
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});
