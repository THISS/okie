import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parsePortableAtlas } from '@okie/architecture';
import type { GithubAuthService, GithubSession } from './githubOAuth.js';
import { OperatorPublicationService } from './operatorPublication.js';
import { OperatorStore } from './operatorStore.js';
import { createScanHttpHandler } from './scanServer.js';

const commit = 'a'.repeat(40);
function auth(): GithubAuthService {
  const session = (request: { headers: Record<string, string | string[] | undefined> }): GithubSession | undefined => request.headers['x-test-user'] === 'operator' ? { id: 'session', login: 'operator', userId: '42', source: 'test-double', token: 'test-token', createdAt: 0 } : request.headers['x-test-user'] === 'member' ? { id: 'member', login: 'member', userId: '7', source: 'test-double', token: 'test-token', createdAt: 0 } : undefined;
  return { config: { publicOrigin: 'http://fixture.test' }, sessionFromRequest: session as GithubAuthService['sessionFromRequest'], publicView: () => ({ signedIn: false }), handle: async () => false } as unknown as GithubAuthService;
}
async function serve(handler: ReturnType<typeof createScanHttpHandler>, run: (origin: string) => Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test address');
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function portable(): string {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), 'utf8').replaceAll('golden-worktree-okie-2026-07-14-v1', commit));
  return JSON.stringify({ format: 'okie-atlas', version: 1, repository: { commitSha: commit, treeHash: 'b'.repeat(40) }, snapshot: read('snapshot'), view: read('view'), story: read('story'), stories: [], analysis: { mode: 'quick', adapters: [{ language: 'typescript', tool: 'typescript', version: '5.9.3', coverage: 'syntax', limitations: [] }] } });
}

test('operator HTTP gates, deduplicates, and serves only private portable draft bundles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'okie-operator-http-')); const store = new OperatorStore(root); const publications = new OperatorPublicationService(store); const enqueued: string[] = [];
  const handler = createScanHttpHandler({ queue: {} as never, allowSubmit: () => true, auth: auth(), scanRoot: root, llm: { baseUrl: '', modelId: 'fake', keySource: 'none' }, enrich: 'off', bind: '127.0.0.1', operator: { auth: auth(), allowedGithubIds: new Set(['42']), publicOrigin: 'http://fixture.test', store, publications, enqueue: job => { enqueued.push(job.runId); } } });
  try { await serve(handler, async origin => {
    assert.equal((await fetch(`${origin}/api/operator/runs`)).status, 401);
    assert.equal((await fetch(`${origin}/api/operator/runs`, { headers: { 'x-test-user': 'member' } })).status, 403);
    const headers = { 'content-type': 'application/json', origin: 'http://fixture.test', 'x-test-user': 'operator' };
    assert.equal((await fetch(`${origin}/api/operator/runs`, { method: 'POST', headers: { ...headers, origin: 'http://evil.test' }, body: JSON.stringify({ url: 'https://github.com/acme/demo', idempotencyKey: 'same-key' }) })).status, 403);
    const first = await fetch(`${origin}/api/operator/runs`, { method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/demo', idempotencyKey: 'same-key' }) }); assert.equal(first.status, 202); const run = (await first.json() as { run: { runId: string; source: { repositoryId: string } } }).run;
    const second = await fetch(`${origin}/api/operator/runs`, { method: 'POST', headers, body: JSON.stringify({ url: 'https://github.com/acme/demo', idempotencyKey: 'same-key' }) }); assert.equal((await second.json() as { deduped: boolean }).deduped, true); assert.equal(enqueued.length, 1);
    const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: commit, files: { 'atlas.okie.json': portable() } }); const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    assert.equal((await fetch(`${origin}/api/operator/drafts/${draft.draftRevisionId}/bundle`)).status, 401);
    const bundle = await fetch(`${origin}/api/operator/drafts/${draft.draftRevisionId}/bundle`, { headers: { 'x-test-user': 'operator' } }); assert.equal(bundle.status, 200); assert.equal(bundle.headers.get('content-type'), 'application/json; charset=utf-8'); parsePortableAtlas(await bundle.text());
    assert.equal((await fetch(`${origin}/scan/acme__demo/atlas.okie.json?version=${draft.draftRevisionId}`)).status, 404);
    assert.equal((await fetch(`${origin}/api/operator/drafts/${draft.draftRevisionId}/retry`, { method: 'POST', headers, body: JSON.stringify({ scopeId: 'anything' }) })).status, 409);
    store.updateRun(run.runId, { state: 'awaiting_review' });
    store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    assert.equal((await fetch(`${origin}/api/operator/drafts/${draft.draftRevisionId}/retry`, { method: 'POST', headers, body: JSON.stringify({ scopeId: 'anything' }) })).status, 409);
  }); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public scan resolution treats GitHub repository case variants as one current publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'okie-operator-case-http-'));
  const store = new OperatorStore(root); const publications = new OperatorPublicationService(store);
  const handler = createScanHttpHandler({ queue: {} as never, allowSubmit: () => true, auth: auth(), scanRoot: root, llm: { baseUrl: '', modelId: 'fake', keySource: 'none' }, enrich: 'off', bind: '127.0.0.1', operator: { auth: auth(), allowedGithubIds: new Set(['42']), publicOrigin: 'http://fixture.test', store, publications, enqueue() {} } });
  try {
    const firstRun = store.createRun({ idempotencyKey: 'case-first', source: { repositoryId: 'repo:Acme/app', owner: 'Acme', repo: 'app', slug: 'acme__app' } }).run;
    const firstArtifact = store.writeArtifactRevision({ repositoryId: firstRun.source.repositoryId, files: { 'snapshot.json': '{"revision":"first"}' } });
    const firstDraft = publications.createDraftRevision({ runId: firstRun.runId, artifactRevisionId: firstArtifact.artifactRevisionId });
    const first = publications.publishDraft({ repositoryId: firstRun.source.repositoryId, draftRevisionId: firstDraft.draftRevisionId });
    assert.equal(first.ok, true);
    const secondRun = store.createRun({ idempotencyKey: 'case-second', source: { repositoryId: 'repo:acme/app', owner: 'acme', repo: 'app', slug: 'acme__app' } }).run;
    const secondArtifact = store.writeArtifactRevision({ repositoryId: secondRun.source.repositoryId, files: { 'snapshot.json': '{"revision":"second"}' } });
    const secondDraft = publications.createDraftRevision({ runId: secondRun.runId, artifactRevisionId: secondArtifact.artifactRevisionId });
    const second = publications.publishDraft({ repositoryId: secondRun.source.repositoryId, draftRevisionId: secondDraft.draftRevisionId, expectedCurrentVersionId: first.publication.versionId });
    assert.equal(second.ok, true);
    await serve(handler, async origin => {
      assert.deepEqual(await (await fetch(`${origin}/scan/acme__app/snapshot.json`)).json(), { revision: 'second' });
      assert.deepEqual(await (await fetch(`${origin}/scan/acme__app/snapshot.json?version=${first.publication.versionId}`)).json(), { revision: 'first' });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
