import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePortableAtlas } from "@okie/architecture";
import { scanRepository } from "@okie/scan";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";

test("runner writes parseable deterministic and immutable enriched drafts", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "x", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
    const runner = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions(body) {
      const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { role?: string; directChildren?: string[]; scope?: { scopeId: string; allowedEvidence: unknown[] } };
      if (message.role === "coordinator") return { json: { choices: [{ message: { content: JSON.stringify({ assignments: (message.directChildren ?? []).map(scopeId => ({ scopeId })) }) } }] } };
      return { json: { choices: [{ message: { content: JSON.stringify({ summary: `Summary ${message.scope!.scopeId}`, evidence: message.scope!.allowedEvidence.slice(0, 1) }) } }] }, usage: { totalTokens: 2 } };
    } } });
    await runner.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    const drafts = store.snapshot().drafts;
    assert.equal(drafts.length, 2);
    const deterministic = store.readArtifactFile(drafts[0]!.artifactRevisionId, "atlas.okie.json")!;
    parsePortableAtlas(deterministic.toString());
    const sidecar = JSON.parse(store.readArtifactFile(drafts[1]!.artifactRevisionId, "operator-explanations.json")!.toString()) as { explanations: Array<{ content: { summary: string } }> };
    assert.match(sidecar.explanations[0]!.content.summary, /^Summary/);
    assert.deepEqual(deterministic, store.readArtifactFile(drafts[0]!.artifactRevisionId, "atlas.okie.json"));
    assert.equal(store.snapshot().publications.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
