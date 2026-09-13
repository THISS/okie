import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";

test("runner creates immutable full-analysis draft without publishing", async () => { const root = mkdtempSync(join(tmpdir(), "okie-runner-")); try { const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "x", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run; let options: unknown; const runner = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async (_source, value) => { options = value; return { commitSha: "abc", artifacts: { extraction: {}, snapshot: { entities: [], relations: [] }, view: {}, scene: {}, story: {}, catalog: {}, timeline: {} } as never }; } }); await runner.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } }); assert.deepEqual((options as { analysisMode: string; codeSurface: string }), { client: (options as { client: unknown }).client, analysisMode: "full", codeSurface: "all" }); assert.equal(store.snapshot().runs[0]?.state, "awaiting_review"); assert.equal(store.snapshot().publications.length, 0); } finally { rmSync(root, { recursive: true, force: true }); } });
