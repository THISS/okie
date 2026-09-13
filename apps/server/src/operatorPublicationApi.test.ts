import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { GithubAuthService, GithubSession } from "./githubOAuth.js";
import { handleOperatorApi } from "./operatorApi.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

const commit = "a".repeat(40);
const requiredFiles = ["atlas.okie.json", "snapshot.json", "view.json", "scene.json", "story.json", "stories.json", "timeline.json"];

function portable(): string {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), "utf8").replaceAll("golden-worktree-okie-2026-07-14-v1", commit));
  return JSON.stringify({ format: "okie-atlas", version: 1, repository: { commitSha: commit, treeHash: "b".repeat(40), url: "https://github.com/acme/demo" }, snapshot: read("snapshot"), view: read("view"), story: read("story"), stories: [], analysis: { mode: "quick", adapters: [{ language: "typescript", tool: "typescript", version: "5.9.3", coverage: "syntax", limitations: [] }] } });
}

function completeFiles(): Record<string, string> {
  const atlas = portable();
  const bundle = JSON.parse(atlas) as { snapshot: unknown; view: unknown; story: unknown };
  return Object.fromEntries(requiredFiles.map(file => [file, file === "atlas.okie.json" ? atlas : file === "snapshot.json" ? JSON.stringify(bundle.snapshot) : file === "view.json" ? JSON.stringify(bundle.view) : file === "story.json" ? JSON.stringify(bundle.story) : "{}"]));
}

const session: GithubSession = { id: "operator-session", login: "operator", userId: "42", source: "test-double", token: "test-token", createdAt: 0 };
const auth = { config: { publicOrigin: "http://fixture.test" }, sessionFromRequest: () => session, publicView: () => ({ authenticated: true }), handle: async () => false } as unknown as GithubAuthService;
const request = { method: "POST", headers: { origin: "http://fixture.test" } } as unknown as IncomingMessage;

function fixture(root: string, input: { files?: Record<string, string>; repositoryId?: string } = {}) {
  const store = new OperatorStore(root);
  const publications = new OperatorPublicationService(store);
  const repositoryId = input.repositoryId ?? "repo:acme/demo";
  const run = store.createRun({ idempotencyKey: `publish-${Math.random()}`, source: { repositoryId, owner: "acme", repo: "demo", slug: "acme-demo", commitSha: commit } }).run;
  const files = input.files ?? completeFiles();
  const artifact = store.writeArtifactRevision({ repositoryId, sourceCommitSha: commit, files });
  const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
  return { store, publications, draft, artifact };
}

async function publish(store: OperatorStore, publications: OperatorPublicationService, draftId: string) {
  return handleOperatorApi({ auth, allowedGithubIds: new Set(["42"]), publicOrigin: "http://fixture.test", store, publications, enqueue() {} }, request, `/api/operator/drafts/${draftId}/publish`, {});
}

test("operator publish accepts a complete portable artifact and advances the current pointer", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-operator-publication-api-"));
  try {
    const { store, publications, draft, artifact } = fixture(root);
    const result = await publish(store, publications, draft.draftRevisionId);

    assert.equal(result?.status, 200);
    assert.equal((result?.body as { ok: boolean }).ok, true);
    assert.equal(store.snapshot().drafts.find(value => value.draftRevisionId === draft.draftRevisionId)?.state, "frozen");
    assert.equal(store.snapshot().publications.length, 1);
    assert.equal(publications.currentPublication(draft.repositoryId)?.artifactRevisionId, artifact.artifactRevisionId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator publish rejects incomplete, malformed, and source-mismatched artifacts before freezing", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-operator-publication-api-"));
  try {
    const cases: Array<{ name: string; files?: Record<string, string>; repositoryId?: string }> = [
      { name: "missing viewer artifact", files: Object.fromEntries(Object.entries(completeFiles()).filter(([file]) => file !== "timeline.json")) },
      { name: "malformed portable atlas", files: { ...completeFiles(), "atlas.okie.json": "not-json" } },
      { name: "source mismatch", files: { ...completeFiles(), "snapshot.json": JSON.stringify({ ...(JSON.parse(portable()) as { snapshot: Record<string, unknown> }).snapshot, commitSha: "c".repeat(40) }) } },
    ];
    for (const invalid of cases) {
      const caseRoot = mkdtempSync(join(root, "case-"));
      const { store, publications, draft } = fixture(caseRoot, invalid);
      const result = await publish(store, publications, draft.draftRevisionId);

      assert.equal(result?.status, 422, invalid.name);
      assert.deepEqual(result?.body, { error: "draft artifact is not publishable" }, invalid.name);
      assert.equal(store.snapshot().drafts.find(value => value.draftRevisionId === draft.draftRevisionId)?.state, "open", invalid.name);
      assert.equal(store.snapshot().publications.length, 0, invalid.name);
      assert.equal(publications.currentPublication(draft.repositoryId), undefined, invalid.name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
