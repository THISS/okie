import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { handleOembedRequest, OEMBED_PATH, oembedAllowedOriginsFromEnv, oembedRequestOrigin } from './src/oembed';

// The local scan process (apps/server) owns /api (submit + job status) and
// /scan (published trio objects + manifest). Dev and preview proxy both there
// so the app's runtime-fetch loader sees the same paths. Target 127.0.0.1 to
// match the server's loopback bind (CLA-17); this process is not a public API.
const scanServiceProxy = {
  '/api': 'http://127.0.0.1:4180',
  '/scan': 'http://127.0.0.1:4180',
};

function oembedPathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/** JSON oEmbed on the web origin so docs sites can embed `/r/<owner>/<repo>`. */
function okieOembedPlugin(): Plugin {
  const attach = (server: Pick<ViteDevServer, 'middlewares'>) => {
    server.middlewares.use((request, response, next) => {
      const pathname = oembedPathname(request.url ?? '/');
      if (pathname !== OEMBED_PATH && pathname !== `${OEMBED_PATH}/`) {
        next();
        return;
      }
      const url = new URL(request.url ?? OEMBED_PATH, 'http://localhost');
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
    });
  };
  return {
    name: 'okie-oembed',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig({
  plugins: [react(), okieOembedPlugin()],
  // SPA so `/new` and `/r/<owner>/<repo>` are public share/view URLs (CLA-30).
  appType: 'spa',
  server: {
    host: 'localhost',
    port: 4173,
    proxy: scanServiceProxy,
  },
  preview: {
    host: 'localhost',
    port: 4173,
    proxy: scanServiceProxy,
  },
});
