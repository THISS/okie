import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The local scan process (apps/server) owns /api (submit + job status) and
// /scan (published trio objects + manifest). Dev and preview proxy both there
// so the app's runtime-fetch loader sees the same paths. Target 127.0.0.1 to
// match the server's loopback bind (CLA-17); this process is not a public API.
const scanServiceProxy = {
  '/api': 'http://127.0.0.1:4180',
  '/scan': 'http://127.0.0.1:4180',
};

export default defineConfig({
  plugins: [react()],
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
