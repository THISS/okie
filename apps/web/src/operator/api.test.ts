import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatorApi } from './api';

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

  it('fetches a draft preview from the authenticated bundle endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ format: 'okie-portable/v1' })));
    globalThis.fetch = fetch;
    await operatorApi.bundle('draft/revision');
    expect(fetch).toHaveBeenCalledWith('/api/operator/drafts/draft%2Frevision/bundle', expect.objectContaining({ credentials: 'same-origin' }));
  });
});
