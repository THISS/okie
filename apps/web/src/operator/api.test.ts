import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorApiError, operatorApi } from './api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('operator API client', () => {
  it('uses the operator-only draft and scoped mutation endpoints', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: { draftRevisionId: 'draft-1' }, source: {}, scopes: [], usage: {} })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: {}, draftRevisionId: 'draft-2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ publication: { versionId: 'version-1' } })));
    globalThis.fetch = fetch;
    await operatorApi.draft('draft-1');
    await operatorApi.retry('draft-1', 'component:api');
    await operatorApi.publish('draft-1', 'version-current', true);
    expect(fetch.mock.calls[0]![0]).toBe('/api/operator/drafts/draft-1');
    expect(fetch.mock.calls[1]![0]).toBe('/api/operator/drafts/draft-1/retry');
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scopeId: 'component:api' }) });
    expect(fetch.mock.calls[2]![1]).toMatchObject({ body: JSON.stringify({ expectedCurrentVersionId: 'version-current', acknowledgeCoverage: true }) });
  });

  it('sends batch retries with scopeIds and the explicit below-cap opt-in only when asked', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ run: {}, draftRevisionId: 'draft-1' })));
    globalThis.fetch = fetch;
    await operatorApi.retryScopes('draft-1', ['a', 'b']);
    await operatorApi.retryScopes('draft-1', ['code:x'], true);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scopeIds: ['a', 'b'] }) });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ scopeIds: ['code:x'], includeBelowCap: true }) });
  });

  it('fetches a draft preview from the authenticated bundle endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ format: 'okie-portable/v1' })));
    globalThis.fetch = fetch;
    await operatorApi.bundle('draft/revision');
    expect(fetch).toHaveBeenCalledWith('/api/operator/drafts/draft%2Frevision/bundle', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('carries the parsed error body on failures and stays constructible without one', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'draft is no longer current', currentDraftRevisionId: 'draft-2' }), { status: 409 }));
    const failure = await operatorApi.retry('draft-1', 'component:api').catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OperatorApiError);
    expect(failure).toMatchObject({ status: 409, message: 'draft is no longer current', body: { currentDraftRevisionId: 'draft-2' } });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 502 }));
    expect(await operatorApi.runs().catch((cause: unknown) => cause)).toMatchObject({ status: 502, message: 'Request failed (502)', body: undefined });
    expect(new OperatorApiError(403, 'operator access required').body).toBeUndefined();
  });

  it('posts "Update to latest commit" to the URL-encoded repository route and returns started / up to date as sent (CLA-271)', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'started', runId: 'run-9', baselineCommitSha: 'aaaaaaa1', commitSha: 'bbbbbbb2' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'up_to_date', commitSha: 'aaaaaaa1', baselineCommitSha: 'aaaaaaa1' })));
    globalThis.fetch = fetch;
    expect(await operatorApi.incremental('repo:acme/app')).toEqual({ status: 'started', runId: 'run-9', baselineCommitSha: 'aaaaaaa1', commitSha: 'bbbbbbb2' });
    expect(await operatorApi.incremental('repo:acme/app', { ref: 'main' })).toMatchObject({ status: 'up_to_date' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/operator/repositories/repo%3Aacme%2Fapp/incremental');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin' });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ ref: 'main' }) });
  });

  it('resolves a 409 run_active to the active run and throws the other refusals with their code (CLA-271)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'active', runId: 'run-7', code: 'run_active', error: 'operator action already running' }), { status: 409 }));
    expect(await operatorApi.incremental('acme/app')).toEqual({ status: 'active', runId: 'run-7' });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'no_baseline', code: 'no_baseline', error: 'repository has no draft or publication to update' }), { status: 422 }));
    expect(await operatorApi.incremental('acme/app').catch((cause: unknown) => cause)).toMatchObject({ status: 422, body: { code: 'no_baseline' } });
    // A 409 without a run id (e.g. an older server) stays an error rather than inventing a target.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'run_active' }), { status: 409 }));
    expect(await operatorApi.incremental('acme/app').catch((cause: unknown) => cause)).toMatchObject({ status: 409 });
  });
});
