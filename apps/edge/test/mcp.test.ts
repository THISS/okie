import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcpRequest, MCP_MAX_REQUEST_BYTES } from '../src/mcp';
import { edgeEnv } from './helpers';

const origin = 'http://127.0.0.1:4196';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
const handle = (request: Request) => handleMcpRequest(request, { bucket: edgeEnv.ATLAS_BUCKET, allowedOrigin: origin });
const rpc = (body: unknown, extra: Record<string, string> = {}) => handle(new Request(`${origin}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) }));

describe('public stateless MCP', () => {
  it('interoperates with the official Streamable HTTP client without cookies or sessions', async () => {
    const calls: Request[] = [];
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      const response = await handle(request);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('mcp-session-id')).toBeNull();
      return response;
    }) as typeof fetch });
    const client = new Client({ name: 'integration-test', version: '1' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual(['list_atlases', 'search_atlas', 'get_entity', 'get_relations', 'get_evidence']);
      expect(listed.tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
      const result = await client.callTool({ name: 'list_atlases', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(calls.every(request => request.headers.get('cookie') === null)).toBe(true);
    } finally { await client.close(); }
  });

  it('handles notifications and unknown tools using SDK JSON-RPC contracts', async () => {
    const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
    const unknown = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_account', arguments: {} } });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ id: 1, result: { isError: true } });
  });

  it('rejects foreign origins, unsupported protocol versions, malformed JSON and non-POST methods', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': 'bad' })).status).toBe(400);
    expect((await handle(new Request(`${origin}/mcp`, { method: 'POST', headers, body: '{' }))).status).toBe(400);
    for (const method of ['GET', 'DELETE', 'PUT']) expect((await handle(new Request(`${origin}/mcp`, { method }))).status).toBe(405);
  });

  it('enforces a byte limit even without Content-Length', async () => {
    const response = await handle(new Request(`${origin}/mcp`, { method: 'POST', headers, body: 'é'.repeat(MCP_MAX_REQUEST_BYTES) }));
    expect(response.status).toBe(413);
  });
});
