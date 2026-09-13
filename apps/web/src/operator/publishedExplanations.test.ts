import { describe, expect, it, vi } from 'vitest';
import { loadPublishedExplanations } from './publishedExplanations';

describe('published explanation sidecar', () => {
  it('requests the immutable sidecar with the bootstrap publication version', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ versionId: 'pub-7', explanations: [{ entityId: 'component:api', scopeId: 'component:api', name: 'API', state: 'accepted', explanation: { summary: 'Handles requests.', evidence: [] } }] })));
    const values = await loadPublishedExplanations('acme__app', 'pub-7', fetch);
    expect(fetch).toHaveBeenCalledWith('/scan/acme__app/operator-explanations.json?version=pub-7');
    expect(values?.[0]?.explanation?.summary).toBe('Handles requests.');
  });
  it('rejects a sidecar from another publication instead of mixing revision content', async () => {
    await expect(loadPublishedExplanations('acme__app', 'pub-7', vi.fn().mockResolvedValue(new Response(JSON.stringify({ versionId: 'pub-8', explanations: [] }))))).rejects.toThrow(/do not match/u);
  });
  it('accepts legacy public atlases with no sidecar', async () => {
    await expect(loadPublishedExplanations('acme__app', 'pub-7', vi.fn().mockResolvedValue(new Response('', { status: 404 })))).resolves.toBeUndefined();
  });
});
