import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { oembedAllowedOriginsFromEnv } from './src/oembed';
import { localScanOriginFromEnv, resolvePublicAtlasShare, trustedShareOrigin } from './src/openGraph';
import { handlePublicAtlasRoute, isPublicAtlasRoutePath } from './src/publicAtlasRoutes';
import { WEBMCP_HOST_HEADERS, webMcpHostHeadersForFetchDest } from './src/webmcpHeaders';

// The local scan process (apps/server) owns /api (submit + job status) and
// /scan (published trio objects + manifest). Dev and preview proxy both there
// so the app's runtime-fetch loader sees the same paths. Target 127.0.0.1 to
// match the server's loopback bind (CLA-17); this process is not a public API.
// OKIE_SCAN_SERVER_PORT points the proxy at a scratch server (e.g. QA on a spare port); default 4180.
// OKIE_SCAN_ORIGIN overrides the whole origin (loopback http or https). The share handlers' published-
// snapshot lookup uses the same configured origin.
const SCAN_ORIGIN = localScanOriginFromEnv(process.env);
const scanServiceProxy = {
  '/api': SCAN_ORIGIN,
  '/scan': SCAN_ORIGIN,
};

function requestPathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function writeNodeResponse(
  response: import('node:http').ServerResponse,
  result: { status: number; headers: Record<string, string>; body: string | Uint8Array },
): void {
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) {
    response.setHeader(name, value);
  }
  response.end(result.body);
}

/** Origin isolation + `tools=(self)` so WebMCP stays same-origin (CLA-40). */
function okieWebMcpHeadersPlugin(): Plugin {
  const attach = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      const headers = webMcpHostHeadersForFetchDest(request.headers['sec-fetch-dest']);
      for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
      }
      if (!('Origin-Agent-Cluster' in headers)) {
        response.removeHeader('Origin-Agent-Cluster');
      }
      next();
    });
  };
  return {
    name: 'okie-webmcp-headers',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

/**
 * Public share surface (CLA-30/39): OG meta on `/r/<owner>/<repo>`, PNG cards at `/og/<owner>/<repo>`
 * and oEmbed JSON at `/oembed` so docs sites can embed `/r/<owner>/<repo>`. The handlers are the same
 * runtime-agnostic ones the edge Worker (apps/edge) serves; here "public" means the configured local scan
 * process has the published snapshot (plus the THISS/okie dogfood rule).
 */
function okieOpenGraphPlugin(): Plugin {
  const sourceIndex = fileURLToPath(new URL('./index.html', import.meta.url));
  const attach = (server: ViteDevServer | PreviewServer, mode: 'dev' | 'preview') => {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = requestPathname(request.url ?? '/');
      if (!isPublicAtlasRoutePath(pathname)) {
        next();
        return;
      }
      void (async () => {
        const allowedOrigins = oembedAllowedOriginsFromEnv(process.env);
        const result = await handlePublicAtlasRoute({
          method: request.method ?? 'GET',
          pathname,
          search: url.search,
          requestOrigin: trustedShareOrigin(request.headers, allowedOrigins) ?? '',
          allowedOrigins,
          isPublicAtlas: (owner, repo) => resolvePublicAtlasShare(owner, repo, SCAN_ORIGIN, fetch, SCAN_ORIGIN),
          indexHtml: async () => {
            const indexPath = mode === 'preview'
              ? fileURLToPath(new URL('./dist/index.html', import.meta.url))
              : sourceIndex;
            const html = readFileSync(indexPath, 'utf8');
            return mode === 'dev' && 'transformIndexHtml' in server
              ? server.transformIndexHtml(request.url ?? pathname, html)
              : html;
          },
        });
        if (!result) {
          next();
          return;
        }
        writeNodeResponse(response, result);
      })().catch(next);
    });
  };
  return {
    name: 'okie-open-graph',
    configureServer: server => attach(server, 'dev'),
    configurePreviewServer: server => attach(server, 'preview'),
  };
}

export default defineConfig({
  plugins: [react(), okieWebMcpHeadersPlugin(), okieOpenGraphPlugin()],
  // SPA so `/new` and `/r/<owner>/<repo>` are public share/view URLs (CLA-30).
  appType: 'spa',
  server: {
    host: 'localhost',
    port: 4173,
    proxy: scanServiceProxy,
    headers: { ...WEBMCP_HOST_HEADERS },
  },
  preview: {
    host: 'localhost',
    port: 4173,
    proxy: scanServiceProxy,
    headers: { ...WEBMCP_HOST_HEADERS },
  },
});
