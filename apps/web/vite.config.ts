import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import {
  handleOembedRequest,
  OEMBED_PATH,
  oembedAllowedOriginsFromEnv,
  parsePublicAtlasOembedUrl,
} from './src/oembed';
import {
  handleOgImageRequest,
  handleShareHtmlRequest,
  isOgImagePath,
  LOCAL_SCAN_ORIGIN,
  resolvePublicAtlasShare,
  trustedShareOrigin,
} from './src/openGraph';
import { isPublicAtlasViewPath as isSharePath } from './src/hostedAtlas';
import { WEBMCP_HOST_HEADERS, webMcpHostHeadersForFetchDest } from './src/webmcp';

// The local scan process (apps/server) owns /api (submit + job status) and
// /scan (published trio objects + manifest). Dev and preview proxy both there
// so the app's runtime-fetch loader sees the same paths. Target 127.0.0.1 to
// match the server's loopback bind (CLA-17); this process is not a public API.
const scanServiceProxy = {
  '/api': 'http://127.0.0.1:4180',
  '/scan': 'http://127.0.0.1:4180',
};
const SCAN_ORIGIN = LOCAL_SCAN_ORIGIN;

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

function publicAtlasLookup(scanOrigin: string) {
  return (owner: string, repo: string) => resolvePublicAtlasShare(owner, repo, scanOrigin);
}

/** JSON oEmbed on the web origin so docs sites can embed `/r/<owner>/<repo>`. */
function okieOembedPlugin(): Plugin {
  const attach = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      const pathname = requestPathname(request.url ?? '/');
      if (pathname !== OEMBED_PATH && pathname !== `${OEMBED_PATH}/`) {
        next();
        return;
      }
      void (async () => {
        const url = new URL(request.url ?? OEMBED_PATH, 'http://localhost');
        const allowedOrigins = oembedAllowedOriginsFromEnv(process.env);
        const origin = trustedShareOrigin(request.headers, allowedOrigins);
        const rawUrl = url.searchParams.get('url');
        const target = rawUrl && origin
          ? parsePublicAtlasOembedUrl(rawUrl, origin, allowedOrigins)
          : undefined;
        const publicOk = target
          ? await resolvePublicAtlasShare(target.owner, target.repo, SCAN_ORIGIN)
          : false;
        const result = handleOembedRequest({
          method: request.method ?? 'GET',
          requestOrigin: origin ?? '',
          searchParams: url.searchParams,
          allowedOrigins,
          isPublicAtlas: () => publicOk,
        });
        writeNodeResponse(response, result);
      })().catch(next);
    });
  };
  return {
    name: 'okie-oembed',
    configureServer: attach,
    configurePreviewServer: attach,
  };
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

/** OG meta on `/r/<owner>/<repo>` and PNG cards at `/og/<owner>/<repo>` (CLA-39). */
function okieOpenGraphPlugin(): Plugin {
  const sourceIndex = fileURLToPath(new URL('./index.html', import.meta.url));
  const attach = (server: ViteDevServer | PreviewServer, mode: 'dev' | 'preview') => {
    server.middlewares.use((request, response, next) => {
      const pathname = requestPathname(request.url ?? '/');
      const isImage = isOgImagePath(pathname);
      const isShare = isSharePath(pathname);
      if (!isImage && !isShare) {
        next();
        return;
      }
      void (async () => {
        const origin = trustedShareOrigin(request.headers, oembedAllowedOriginsFromEnv(process.env));
        const lookup = publicAtlasLookup(SCAN_ORIGIN);
        if (isImage) {
          writeNodeResponse(response, await handleOgImageRequest({
            method: request.method ?? 'GET',
            pathname,
            isPublicAtlas: lookup,
          }));
          return;
        }
        const indexPath = mode === 'preview'
          ? fileURLToPath(new URL('./dist/index.html', import.meta.url))
          : sourceIndex;
        let indexHtml = readFileSync(indexPath, 'utf8');
        if (mode === 'dev' && 'transformIndexHtml' in server) {
          indexHtml = await server.transformIndexHtml(request.url ?? pathname, indexHtml);
        }
        writeNodeResponse(response, await handleShareHtmlRequest({
          method: request.method ?? 'GET',
          pathname,
          search: '',
          requestOrigin: origin ?? '',
          indexHtml,
          allowedOrigins: oembedAllowedOriginsFromEnv(process.env),
          isPublicAtlas: lookup,
        }));
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
  plugins: [react(), okieWebMcpHeadersPlugin(), okieOembedPlugin(), okieOpenGraphPlugin()],
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
