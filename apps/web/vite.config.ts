import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The paste-a-repo scan service (apps/server) owns /api (submit + job status) and
// /scan (published trio objects + manifest). Dev and preview proxy both there so
// the app's runtime-fetch loader sees the same paths a hosted deployment serves.
const scanServiceProxy = {
  '/api': 'http://localhost:4175',
  '/scan': 'http://localhost:4175',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: scanServiceProxy,
  },
  preview: {
    port: 4173,
    proxy: scanServiceProxy,
  },
});
