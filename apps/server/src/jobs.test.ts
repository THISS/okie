import assert from "node:assert/strict";
import test from "node:test";
import { createScanJobQueue, createSubmitLimiter, type ScanJob } from "./jobs.js";

const request = (slug = "o__r", ref?: string) => ({
  owner: "o",
  repo: "r",
  slug,
  ...(ref ? { ref } : {}),
});

test("queue runs jobs FIFO one at a time and completes them", async () => {
  const order: string[] = [];
  const queue = createScanJobQueue(async job => {
    order.push(job.slug);
  });
  queue.submit(request("a__a"));
  queue.submit(request("b__b"));
  queue.submit(request("c__c"));
  await queue.idle();
  assert.deepEqual(order, ["a__a", "b__b", "c__c"]);
  assert.deepEqual(queue.list().map(job => job.stage), ["complete", "complete", "complete"]);
});

test("queue dedupes an active job for the same repo@ref but not across refs", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const queue = createScanJobQueue(async () => { await gate; });

  const first = queue.submit(request("o__r"));
  const again = queue.submit(request("o__r"));
  const pinned = queue.submit(request("o__r", "v3"));
  assert.equal(again.deduped, true);
  assert.equal(again.job.id, first.job.id);
  assert.equal(pinned.deduped, false);
  assert.notEqual(pinned.job.id, first.job.id);

  release();
  await queue.idle();
  // A finished job no longer dedupes — a re-submit is a fresh (idempotent) rescan.
  const rescan = queue.submit(request("o__r"));
  assert.equal(rescan.deduped, false);
  await queue.idle();
});

test("a runner throw fails that job and the queue keeps going", async () => {
  const queue = createScanJobQueue(async job => {
    if (job.slug === "bad__bad") throw new Error("tarball too large");
  });
  queue.submit(request("bad__bad"));
  queue.submit(request("good__good"));
  await queue.idle();
  const bySlug = new Map(queue.list().map(job => [job.slug, job]));
  assert.equal(bySlug.get("bad__bad")!.stage, "failed");
  assert.equal(bySlug.get("bad__bad")!.error, "tarball too large");
  assert.equal(bySlug.get("good__good")!.stage, "complete");
});

test("a runner that marks failure itself is not overwritten to complete", async () => {
  const queue = createScanJobQueue(async (_job: ScanJob, update) => {
    update({ stage: "failed", error: "explicit" });
  });
  queue.submit(request());
  await queue.idle();
  assert.equal(queue.list()[0]!.stage, "failed");
});

test("submit limiter allows a burst then blocks until the window rolls", () => {
  let at = 0;
  const allow = createSubmitLimiter(2, 1_000, () => at);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), false);
  assert.equal(allow("other"), true);
  at = 1_000;
  assert.equal(allow("ip"), true);
});
