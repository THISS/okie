import type { IncomingMessage, ServerResponse } from 'node:http';
import { oembedAllowedOriginsFromEnv } from '../src/oembed';
import {
  defaultIsPublicAtlas,
  handleShareHtmlRequest,
  resolvePublicAtlasShare,
  trustedScanLookupOrigin,
  trustedShareOrigin,
} from '../src/openGraph';

/**
 * Vercel serverless stand-in for the Vite `/r/<owner>/<repo>` HTML injector.
 * Rewritten from `/r/:owner/:repo` in vercel.json so crawlers (and GET) see
 * Open Graph tags on the share URL instead of the generic SPA shell.
 */
const FALLBACK_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

async function loadIndexHtml(origin: string | undefined, allowedOrigins: readonly string[]): Promise<string> {
  if (!origin || !allowedOrigins.includes(origin) || !origin.startsWith('https:')) {
    return FALLBACK_INDEX;
  }
  try {
    const response = await fetch(new URL('/index.html', origin));
    if (response.ok) return await response.text();
  } catch {
    // Crawler-complete fallback; the SPA scripts live on /index.html.
  }
  return FALLBACK_INDEX;
}

export default function handler(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/r', 'http://localhost');
  const owner = url.searchParams.get('owner') ?? '';
  const repo = url.searchParams.get('repo') ?? '';
  const allowedOrigins = oembedAllowedOriginsFromEnv(process.env);
  const origin = trustedShareOrigin(request.headers, allowedOrigins) ?? '';
  const scanOrigin = trustedScanLookupOrigin(origin, allowedOrigins);
  void (async () => {
    const indexHtml = await loadIndexHtml(origin || undefined, allowedOrigins);
    const result = await handleShareHtmlRequest({
      method: request.method ?? 'GET',
      pathname: `/r/${owner}/${repo}`,
      search: '',
      requestOrigin: origin,
      indexHtml,
      allowedOrigins,
      isPublicAtlas: (atlasOwner, atlasRepo) => scanOrigin
        ? resolvePublicAtlasShare(atlasOwner, atlasRepo, scanOrigin)
        : defaultIsPublicAtlas(atlasOwner, atlasRepo),
    });
    response.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.end(result.body);
  })().catch(() => {
    response.statusCode = 404;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('not found');
  });
}
