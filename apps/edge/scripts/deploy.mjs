#!/usr/bin/env node
// Deploy the edge Worker to `staging` or `production` (CLA-266).
//
//   pnpm --filter @okie/edge deploy:staging
//   pnpm --filter @okie/edge deploy:production
//
// Credentials: `wrangler login` (OAuth). The account comes from `account_id` in wrangler.jsonc (or the
// OAuth session); nothing is read from .env. CLOUDFLARE_API_TOKEN is removed from wrangler's env when
// present, because a token overrides the OAuth login. The browse-only launch has no container, so no
// Docker is needed; it requires a built apps/web/dist (`pnpm build`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENVIRONMENTS = new Set(['staging', 'production']);
const API_TOKEN = 'CLOUDFLARE_API_TOKEN';

const target = process.argv[2];
if (!ENVIRONMENTS.has(target)) {
  console.error(`usage: deploy.mjs <${[...ENVIRONMENTS].join('|')}> [extra wrangler args]`);
  process.exit(2);
}

const edgeDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const env = { ...process.env };
if (env[API_TOKEN]) {
  delete env[API_TOKEN];
  console.log(`note: ignoring ${API_TOKEN} so wrangler uses your \`wrangler login\` session`);
}
if (!existsSync(`${repoRoot}apps/web/dist/index.html`)) {
  console.error('apps/web/dist is missing; run `pnpm build` first');
  process.exit(1);
}
console.log(`deploying sourcefor-atlas to ${target} (browse-only, no container; OAuth login, account from wrangler.jsonc)`);
const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--env', target, ...process.argv.slice(3)], {
  cwd: edgeDir,
  env,
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error('deploy failed. First deploy on a fresh account: 10063 = no workers.dev subdomain yet (open Workers & Pages in the dashboard once); 100117 = the custom-domain hostname already has DNS records (delete them first). See docs/deploy/cloudflare-runbook.md.');
}
process.exit(result.status ?? 1);
