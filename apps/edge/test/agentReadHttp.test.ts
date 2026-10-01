import { describe, expect, it, vi } from 'vitest';
import { edgeFetch, recordingBackend } from './helpers';

const query = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'list_atlases', arguments: {} }) };
describe('agent read admission', () => {
  it('defaults off and never wakes the backend or charges Ask', async () => {
    const { backend, seen } = recordingBackend();
    expect((await edgeFetch('/api/atlas/query', { init: query, backend })).status).toBe(404);
    const response = await edgeFetch('/api/atlas/query', { init: query, backend, env: { AGENT_READS_ENABLED: '1', AGENT_RATE_LIMITER: undefined } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ atlases: [] });
    expect(seen).toHaveLength(0);
  });
  it('uses a separate limiter, fails closed on limiter failure, rejects foreign browser origins', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = { AGENT_READS_ENABLED: '1', AGENT_RATE_LIMITER: { limit } };
    expect((await edgeFetch('/mcp', { init: query, env })).status).toBe(429);
    expect(limit.mock.calls[0]![0].key).toMatch(/^atlas-read:/);
    limit.mockRejectedValue(new Error('unavailable'));
    expect((await edgeFetch('/api/atlas/query', { init: query, env })).status).toBe(503);
    expect((await edgeFetch('/api/atlas/query', { init: { ...query, headers: { ...query.headers, origin: 'https://attacker.invalid' } }, env })).status).toBe(403);
  });
  it('bounds bytes and refuses malformed requests and unsupported methods', async () => {
    const env = { AGENT_READS_ENABLED: '1', AGENT_RATE_LIMITER: undefined };
    expect((await edgeFetch('/api/atlas/query', { env })).status).toBe(405);
    expect((await edgeFetch('/api/atlas/query', { init: { ...query, body: 'é'.repeat(16384) }, env })).status).toBe(413);
    expect((await edgeFetch('/api/atlas/query', { init: { ...query, body: '{' }, env })).status).toBe(400);
    expect((await edgeFetch('/api/atlas/query', { init: { ...query, headers: { 'content-type': 'text/plain' } }, env })).status).toBe(415);
  });
});
