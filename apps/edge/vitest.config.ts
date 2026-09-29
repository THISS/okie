import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/** wrangler.jsonc uses full-line `//` comments only (asserted in test/config.test.ts). */
export function readWranglerConfig(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

// Tests run inside workerd (Miniflare) with the real wrangler.jsonc bindings (R2, Durable Objects,
// rate limiter, vars). Two test-only differences, written to a generated config under .wrangler/:
//   - no `containers` entry: its Dockerfile belongs to apps/server and the test run never needs Docker
//     (routing takes an injectable Backend; the container class is tested as a plain module);
//   - static assets come from a tiny fixture instead of ../web/dist, so `pnpm test` needs no web build.
//     The home page's real /home.js (a plain file in ../web/public, no build step) and its `_headers`
//     rule are copied in, so the tests serve the file that ships.
const root = fileURLToPath(new URL('.', import.meta.url));
const config = readWranglerConfig(`${root}wrangler.jsonc`);
const generatedDir = `${root}.wrangler/vitest`;
const assetsDir = `${generatedDir}/assets`;
rmSync(assetsDir, { recursive: true, force: true });
cpSync(`${root}test/fixtures/assets`, assetsDir, { recursive: true });
copyFileSync(`${root}../web/public/home.js`, `${assetsDir}/home.js`);
const homeScriptRule = /^\/home\.js\n(?:[ \t]+\S.*\n?)+/m.exec(readFileSync(`${root}../web/public/_headers`, 'utf8'))?.[0];
if (!homeScriptRule) throw new Error('apps/web/public/_headers has no /home.js rule');
appendFileSync(`${assetsDir}/_headers`, `\n${homeScriptRule.trimEnd()}\n`);
delete config.containers;
delete config.env;
config.main = `${root}src/index.ts`;
config.assets = { ...(config.assets as object), directory: assetsDir };
mkdirSync(generatedDir, { recursive: true });
writeFileSync(`${generatedDir}/wrangler.json`, `${JSON.stringify(config, null, 2)}\n`);

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: `${generatedDir}/wrangler.json` } })],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
