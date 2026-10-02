import { describe, expect, it, vi } from 'vitest';
import { edgeFetch, recordingBackend } from './helpers';

const query = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'list_atlases', arguments: {} }) };
describe('agent read admission', () => {
  it('routes MCP initialization and discovery through the edge without waking the backend', async () => {
    const { backend, seen } = recordingBackend();
    const env = { AGENT_READS_ENABLED: '1', AGENT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } };
    const rpc = (body: unknown) => edgeFetch('/mcp', { backend, env, init: {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body),
    } });
    const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'route-test', version: '1' },
    } });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    const discovery = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(discovery.status).toBe(200);
    const body = await discovery.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map(tool => tool.name)).toEqual(['list_atlases', 'search_atlas', 'get_entity', 'get_relations', 'get_evidence']);
    expect(seen).toHaveLength(0);
    expect(env.AGENT_RATE_LIMITER.limit).toHaveBeenCalledTimes(2);
  });
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
