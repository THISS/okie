// Pure helpers for scripts/deploy.mjs (no Node imports, so the edge tests run them in workerd).

/**
 * Whether deploy.mjs applies the remote USERS_DB migrations before `wrangler deploy`: always, except for a
 * `--dry-run` (which must never touch the remote database).
 * @param {string[]} extraArgs  the wrangler args after the environment name
 */
export function appliesRemoteMigrations(extraArgs) {
  return !extraArgs.includes('--dry-run');
}
