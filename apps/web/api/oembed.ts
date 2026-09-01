import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleOembedRequest, oembedAllowedOriginsFromEnv, oembedRequestOrigin } from '../src/oembed';

/**
 * Vercel serverless stand-in for the Vite `/oembed` plugin. Rewritten from
 * `/oembed` in vercel.json so a static host can still answer docs-site
 * discovery with JSON (not the SPA shell).
 */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/oembed', 'http://localhost');
  const origin = oembedRequestOrigin(request.headers);
  const result = handleOembedRequest({
    method: request.method ?? 'GET',
    requestOrigin: origin ?? '',
    searchParams: url.searchParams,
    allowedOrigins: oembedAllowedOriginsFromEnv(process.env),
  });
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) {
    response.setHeader(name, value);
  }
  response.end(result.body);
}
