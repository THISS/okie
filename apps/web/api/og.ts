import type { IncomingMessage, ServerResponse } from 'node:http';
import { oembedRequestOrigin } from '../src/oembed';
import { handleOgImageRequest, resolvePublicAtlasShare } from '../src/openGraph';

/**
 * Vercel serverless stand-in for the Vite `/og/<owner>/<repo>` plugin.
 * Rewritten from `/og/:owner/:repo` in vercel.json so crawlers fetch a PNG
 * atlas card instead of the SPA shell.
 */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/og', 'http://localhost');
  const owner = url.searchParams.get('owner') ?? '';
  const repo = url.searchParams.get('repo') ?? '';
  const origin = oembedRequestOrigin(request.headers) ?? '';
  void (async () => {
    const result = await handleOgImageRequest({
      method: request.method ?? 'GET',
      pathname: `/og/${owner}/${repo}`,
      isPublicAtlas: (atlasOwner, atlasRepo) => resolvePublicAtlasShare(atlasOwner, atlasRepo, origin),
    });
    response.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.end(result.body);
  })().catch(() => {
    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('not found');
  });
}
