import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleOembedRequest,
  oembedAllowedOriginsFromEnv,
  oembedRequestOrigin,
  parsePublicAtlasOembedUrl,
} from '../src/oembed';
import { resolvePublicAtlasShare } from '../src/openGraph';

/**
 * Vercel serverless stand-in for the Vite `/oembed` plugin. Rewritten from
 * `/oembed` in vercel.json so a static host can still answer docs-site
 * discovery with JSON (not the SPA shell).
 */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/oembed', 'http://localhost');
  const origin = oembedRequestOrigin(request.headers);
  const allowedOrigins = oembedAllowedOriginsFromEnv(process.env);
  const rawUrl = url.searchParams.get('url');
  const target = rawUrl && origin
    ? parsePublicAtlasOembedUrl(rawUrl, origin, allowedOrigins)
    : undefined;
  void (async () => {
    const publicOk = target && origin
      ? await resolvePublicAtlasShare(target.owner, target.repo, origin)
      : false;
    const result = handleOembedRequest({
      method: request.method ?? 'GET',
      requestOrigin: origin ?? '',
      searchParams: url.searchParams,
      allowedOrigins,
      isPublicAtlas: () => publicOk,
    });
    response.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.end(result.body);
  })().catch(() => {
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(`${JSON.stringify({ error: 'not a public atlas URL' }, null, 2)}\n`);
  });
}
