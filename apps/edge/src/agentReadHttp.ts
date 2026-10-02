import { AgentAtlasError, executeAgentTool } from './agentAtlas';
import type { EdgeEnv } from './env';
import { clientRateLimitKey } from './guards';
import { jsonResponse, notFoundJson } from './http';
import { handleMcpRequest, MCP_MAX_REQUEST_BYTES } from './mcp';

/** Public published data only. Admission is independent of account/model quotas. */
export async function handleAgentReadRequest(request: Request, env: EdgeEnv): Promise<Response> {
  if (env.AGENT_READS_ENABLED !== '1') return notFoundJson();
  const url = new URL(request.url);
  const allowedOrigin = env.OKIE_PUBLIC_ORIGIN || url.origin;
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== allowedOrigin) return jsonResponse(403, { error: 'Origin is not allowed.' });
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Use POST.' }, { allow: 'POST' });
  if (env.AGENT_RATE_LIMITER) {
    try {
      const result = await env.AGENT_RATE_LIMITER.limit({ key: `atlas-read:${clientRateLimitKey(request.headers.get('cf-connecting-ip') || 'unknown')}` });
      if (!result.success) return jsonResponse(429, { error: 'Atlas read limit reached. Try again shortly.' }, { 'retry-after': '60' });
    } catch { return jsonResponse(503, { error: 'Atlas reads are temporarily unavailable.' }); }
  } else if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return jsonResponse(503, { error: 'Atlas reads are temporarily unavailable.' });
  }
  if (url.pathname === '/mcp') return handleMcpRequest(request, { bucket: env.ATLAS_BUCKET, allowedOrigin });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return jsonResponse(415, { error: 'Use application/json.' });
  const reader = request.body?.getReader();
  if (!reader) return jsonResponse(400, { error: 'An atlas query is required.' });
  let text = '', size = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MCP_MAX_REQUEST_BYTES) { await reader.cancel(); return jsonResponse(413, { error: 'Atlas query is too large.' }); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse(400, { error: 'Invalid atlas query.' });
    const { tool, arguments: args } = body as { tool?: unknown; arguments?: unknown };
    if (typeof tool !== 'string') return jsonResponse(400, { error: 'Invalid atlas query.' });
    return jsonResponse(200, await executeAgentTool(tool, args ?? {}, { bucket: env.ATLAS_BUCKET }));
  } catch (error) {
    if (error instanceof AgentAtlasError) return jsonResponse(error.code === 'invalid_arguments' ? 400 : error.code === 'not_found' ? 404 : 503, { error: error.message });
    return jsonResponse(400, { error: 'Invalid atlas query.' });
  }
}
