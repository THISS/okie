import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASK_WORKER_HEAP_MB, ASK_WORKER_MAX_INDEXES, resolveAskWorkerEnv } from "./askWorker.js";
import { fixtureTrio } from "./publishedAtlas.fixture.js";
import {
  DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES,
  publishedTrioCacheKeys,
  resetPublishedTrioCache,
  resolvePublishedTrioCacheEntries,
  serveNeighborhoodPacket,
  setPublishedTrioCacheLimit,
} from "./scanNeighborhood.js";

test("CLA-266 container sizing: Ask worker heap and warm indexes come from env, defaults unchanged", () => {
  assert.deepEqual(resolveAskWorkerEnv({}), {});
  assert.equal(ASK_WORKER_HEAP_MB, 1_536);
  assert.equal(ASK_WORKER_MAX_INDEXES, 4);
  assert.deepEqual(resolveAskWorkerEnv({ OKIE_ASK_WORKER_MAX_HEAP_MB: "512", OKIE_ASK_MAX_WARM_INDEXES: "2" }), { heapMb: 512, maxIndexes: 2 });
  assert.deepEqual(resolveAskWorkerEnv({ OKIE_ASK_WORKER_MAX_HEAP_MB: "0", OKIE_ASK_MAX_WARM_INDEXES: "lots" }), {});
  assert.equal(resolvePublishedTrioCacheEntries({}), DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES);
  assert.equal(resolvePublishedTrioCacheEntries({ OKIE_NEIGHBORHOOD_CACHE_ENTRIES: "2" }), 2);
  assert.equal(resolvePublishedTrioCacheEntries({ OKIE_NEIGHBORHOOD_CACHE_ENTRIES: "-1" }), DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES);
});

test("CLA-266 container sizing: the parsed-trio cache is a bounded LRU; evicted slugs still serve", () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-trio-lru-"));
  try {
    const slugs = ["a__one", "b__two", "c__three"];
    for (const slug of slugs) {
      const trio = fixtureTrio(slug);
      mkdirSync(join(scanRoot, slug));
      writeFileSync(join(scanRoot, slug, "snapshot.json"), JSON.stringify(trio.snapshot));
      writeFileSync(join(scanRoot, slug, "view.json"), JSON.stringify(trio.view));
    }
    setPublishedTrioCacheLimit(2);
    const serve = (slug: string) => serveNeighborhoodPacket(scanRoot, { pathname: `/scan/${slug}/neighborhood.json`, searchParams: new URLSearchParams() });
    for (const slug of slugs) assert.ok(serve(slug)?.snapshot.entities.some(entity => entity.name === `${slug} system`));
    assert.deepEqual(publishedTrioCacheKeys().map(path => path.split("/").at(-2)), ["b__two", "c__three"]);
    // A hit refreshes recency; the least recently used entry is the one evicted.
    serve("b__two");
    serve("a__one");
    assert.deepEqual(publishedTrioCacheKeys().map(path => path.split("/").at(-2)), ["b__two", "a__one"]);
    assert.ok(serve("c__three")?.snapshot.entities.some(entity => entity.name === "c__three system"));
    assert.equal(publishedTrioCacheKeys().length, 2);
  } finally {
    setPublishedTrioCacheLimit(DEFAULT_PUBLISHED_TRIO_CACHE_ENTRIES);
    resetPublishedTrioCache();
    rmSync(scanRoot, { recursive: true, force: true });
  }
});
