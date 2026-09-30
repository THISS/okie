// scripts/deploy.mjs's logic, with Node's side effects passed in (no Node imports, so the edge tests run it
// in workerd with fakes). deploy.mjs only wires the real fs/child_process/process into runDeploy.

/**
 * Whether deploy.mjs applies the remote USERS_DB migrations before `wrangler deploy`: always, except for a
 * `--dry-run` (which must never touch the remote database).
 * @param {string[]} extraArgs  the wrangler args after the environment name
 */
export function appliesRemoteMigrations(extraArgs) {
  return !extraArgs.includes('--dry-run');
}

/**
 * The marker for unfilled or unconfirmed privacy copy (PRIVACY_COPY_PENDING in apps/web/src/privacyPage.ts):
 * the bare tag and the `: <what to do>` form both start with it.
 */
export const PRIVACY_PENDING_MARKER = ['[pending', 'owner'].join(' ');
export const PRIVACY_PENDING_MESSAGE = 'privacy copy has an unfilled placeholder (apps/web/src/privacyPage.ts)';

/**
 * Why `target` must not deploy, or undefined. Production refuses while the privacy page's source still
 * contains the pending marker; staging may deploy with it.
 * @param {string} target
 * @param {string} privacySource  the text of apps/web/src/privacyPage.ts
 */
export function deployBlockedReason(target, privacySource) {
  if (target === 'production' && privacySource.includes(PRIVACY_PENDING_MARKER)) return PRIVACY_PENDING_MESSAGE;
  return undefined;
}

export const ENVIRONMENTS = ['staging', 'production'];
export const API_TOKEN = 'CLOUDFLARE_API_TOKEN';

/**
 * Deploy the edge Worker; returns the process exit code. Every side effect goes through `deps`, so a test
 * can prove what runs (and what never runs) for each target and flag.
 * @param {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   edgeDir: string,
 *   repoRoot: string,
 *   readFile: (path: string) => string,
 *   exists: (path: string) => boolean,
 *   spawn: (command: string, args: string[], options: { cwd: string, env: Record<string, string | undefined>, stdio: unknown }) => { status: number | null },
 *   log: (message: string) => void,
 *   error: (message: string) => void,
 * }} deps  argv is process.argv (target at [2], extra wrangler args after it)
 * @returns {number}
 */
export function runDeploy(deps) {
  const { argv, edgeDir, repoRoot, readFile, exists, spawn, log, error } = deps;
  const target = argv[2];
  if (!ENVIRONMENTS.includes(target)) {
    error(`usage: deploy.mjs <${ENVIRONMENTS.join('|')}> [extra wrangler args]`);
    return 2;
  }
  const extraArgs = argv.slice(3);
  const env = { ...deps.env };
  if (env[API_TOKEN]) {
    delete env[API_TOKEN];
    log(`note: ignoring ${API_TOKEN} so wrangler uses your \`wrangler login\` session`);
  }
  const dryRun = !appliesRemoteMigrations(extraArgs);
  // Production never ships unfilled privacy copy (CLA-316); staging may. A dry run only warns: it deploys nothing.
  const blocked = deployBlockedReason(target, readFile(`${repoRoot}apps/web/src/privacyPage.ts`));
  if (blocked && !dryRun) {
    error(`refusing to deploy ${target}: ${blocked}`);
    return 1;
  }
  if (blocked) log(`warning: a real deploy to ${target} would be refused: ${blocked}`);
  if (!exists(`${repoRoot}apps/web/dist/index.html`)) {
    error('apps/web/dist is missing; run `pnpm build` first');
    return 1;
  }
  // Accounts schema first (CLA-316): the new Worker must never run against an older USERS_DB schema.
  // Already-applied migrations are skipped; any failure stops the deploy before `wrangler deploy`.
  if (dryRun) log('--dry-run: skipping the remote USERS_DB migrations');
  else log(`applying USERS_DB migrations to ${target} (remote D1)`);
  const migrations = dryRun ? { status: 0 } : spawn('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'USERS_DB', '--env', target, '--remote'], {
    cwd: edgeDir,
    env: { ...env, CI: 'true' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (migrations.status !== 0) {
    error('USERS_DB migrations failed; not deploying. See docs/deploy/cloudflare-runbook.md (Sign-in).');
    return migrations.status ?? 1;
  }
  log(`deploying sourcefor-atlas to ${target} (browse-only, no container; OAuth login, account from wrangler.jsonc)`);
  const result = spawn('pnpm', ['exec', 'wrangler', 'deploy', '--env', target, ...extraArgs], {
    cwd: edgeDir,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    error('deploy failed. First deploy on a fresh account: 10063 = no workers.dev subdomain yet (open Workers & Pages in the dashboard once); 100117 = the custom-domain hostname already has DNS records (delete them first). See docs/deploy/cloudflare-runbook.md.');
  }
  return result.status ?? 1;
}
