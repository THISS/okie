import assert from "node:assert/strict";
import test from "node:test";
import { createScanJobQueue, createSubmitLimiter, toPublicJob, type ScanJob } from "./jobs.js";

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

test("job.error scrubs GitHub-shaped tokens from a runner throw", async () => {
  const planted = "gho_okieTestPlantedSecretCla25xxxx";
  const queue = createScanJobQueue(async () => {
    throw new Error(`llm gateway 401: ${planted}`);
  });
  queue.submit(request("bad__bad"));
  await queue.idle();
  const job = queue.list()[0]!;
  assert.equal(job.stage, "failed");
  assert.equal((job.error ?? "").includes(planted), false);
  assert.match(job.error ?? "", /\[redacted-token\]/);
  assert.match(job.error ?? "", /llm gateway 401/);
});

test("a runner that marks failure itself is not overwritten to complete", async () => {
  const queue = createScanJobQueue(async (_job: ScanJob, update) => {
    update({ stage: "failed", error: "explicit" });
  });
  queue.submit(request());
  await queue.idle();
  assert.equal(queue.list()[0]!.stage, "failed");
});

test("toPublicJob exposes a login-free /r atlas path and never a token field", () => {
  const job: ScanJob = {
    id: "job-1-thiss__okie",
    slug: "thiss__okie",
    owner: "THISS",
    repo: "okie",
    stage: "complete",
    createdAt: 1,
    updatedAt: 2,
    atlasReady: true,
    enrichment: { state: "skipped" },
  };
  const publicJob = toPublicJob(job);
  assert.equal(publicJob.atlasPath, "/r/THISS/okie");
  assert.equal(publicJob.fixtureParam, "scan:thiss__okie");
  assert.equal("token" in publicJob, false);
  assert.equal("githubAccess" in publicJob, false);
  assert.equal("apiKey" in publicJob, false);
});

test("toPublicJob redacts notes and errors and never carries a raw key field", () => {
  const planted = "https://okietest:okie-test-url-token-cla29-fake@example.invalid/v1?api_key=okie-test-query-token-cla29-fake";
  const job: ScanJob = {
    id: "job-1-o__r",
    slug: "o__r",
    owner: "o",
    repo: "r",
    stage: "complete",
    createdAt: 1,
    updatedAt: 2,
    atlasReady: true,
    enrichment: {
      state: "failed",
      note: `llm gateway 401: ${planted}`,
      modelId: "acme/fast",
      provider: "example.invalid",
    },
    error: `boom ${planted}`,
  };
  const publicJob = toPublicJob(job, text => text.replace(/okie-test-[a-z0-9-]+/g, "[redacted]"));
  const json = JSON.stringify(publicJob);
  assert.equal(json.includes("okie-test-url-token-cla29-fake"), false);
  assert.equal(json.includes("okie-test-query-token-cla29-fake"), false);
  assert.equal("apiKey" in publicJob, false);
  const enrichment = publicJob.enrichment as { state: string; modelId: string; provider: string };
  assert.equal(enrichment.state, "failed");
  assert.equal(enrichment.modelId, "acme/fast");
  assert.equal(enrichment.provider, "example.invalid");
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
