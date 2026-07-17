import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRepository } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { pinRepository } from "./pin.js";
import { buildScanArtifacts, stableJson } from "./scan.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readFile = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");

/** Deterministic LCG shuffle so the test itself uses no wall-clock randomness. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = (seed * 2654435761) >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x100000000;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = result[i]!;
    result[i] = result[j]!;
    result[j] = a;
  }
  return result;
}

test("extraction is byte-identical across many shuffled discovery orders", () => {
  const discovery = discoverRepository(repoRoot);
  assert.ok(discovery.sourceFiles.length > 40, "expected a non-trivial source set");
  const canonical = stableJson(extractArchitecture({ discovery, readFile, systemName: "Okie", systemSlug: "okie" }));
  for (let seed = 1; seed <= 24; seed += 1) {
    const shuffled = {
      ...discovery,
      sourceFiles: shuffle(discovery.sourceFiles, seed),
      units: shuffle(discovery.units, seed + 500),
    };
    const output = stableJson(extractArchitecture({ discovery: shuffled, readFile, systemName: "Okie", systemSlug: "okie" }));
    assert.equal(output, canonical, `extraction differs under shuffle seed ${seed}`);
  }
});

test("full scan artifacts are byte-identical across reversed discovery order", () => {
  // snapshot/view/story/scene/timeline are pure functions of the (order-independent)
  // extraction, so one reversed pass proves the whole artifact set is deterministic.
  const pin = pinRepository(repoRoot);
  const discovery = discoverRepository(repoRoot);
  const canonical = buildScanArtifacts({ discovery, pin, readFile, repositorySlug: "okie", systemName: "Okie" });
  const reversed = buildScanArtifacts({
    discovery: { ...discovery, sourceFiles: [...discovery.sourceFiles].reverse(), units: [...discovery.units].reverse() },
    pin,
    readFile,
    repositorySlug: "okie",
    systemName: "Okie",
  });
  for (const key of ["extraction", "snapshot", "view", "story", "scene", "timeline"] as const) {
    assert.equal(stableJson(canonical[key]), stableJson(reversed[key]), `${key} differs under reversed discovery order`);
  }
});
