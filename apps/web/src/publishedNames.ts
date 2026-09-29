/**
 * Display names of a published atlas (CLA-318). A published index row stores `owner` / `repo` as the
 * operator's scan named them (often lower-case: `burntsushi`), and, since CLA-318, GitHub's own casing
 * in `ownerLogin` / `repoName` (`BurntSushi`), recorded at publish time or by
 * `pnpm publish:atlas --backfill-names`. Shown text and GitHub links prefer GitHub's casing; canonical
 * URLs stay in slug form. Runtime-agnostic: the web app, the edge Worker and the Vite plugin share it.
 */

export type PublishedNames = {
  owner: string;
  repo: string;
  /** True when `owner`/`repo` are GitHub's own casing (ownerLogin/repoName), false for the stored fallback. */
  canonical: boolean;
};

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function name(value: unknown): string | undefined {
  return typeof value === 'string' && GITHUB_NAME.test(value) ? value : undefined;
}

/**
 * Names to show for an index row: `ownerLogin`/`repoName` when both are present, valid and the same
 * names as `owner`/`repo` ignoring case (so a stale or mismatched row never renames an atlas);
 * otherwise the stored `owner`/`repo`. Undefined when the row has no usable owner/repo.
 */
export function publishedNamesFor(row: unknown): PublishedNames | undefined {
  const value = row as { owner?: unknown; repo?: unknown; ownerLogin?: unknown; repoName?: unknown } | null | undefined;
  const owner = name(value?.owner);
  const repo = name(value?.repo);
  if (!owner || !repo) return undefined;
  const ownerLogin = name(value?.ownerLogin);
  const repoName = name(value?.repoName);
  if (ownerLogin && repoName && ownerLogin.toLowerCase() === owner.toLowerCase() && repoName.toLowerCase() === repo.toLowerCase()) {
    return { owner: ownerLogin, repo: repoName, canonical: true };
  }
  return { owner, repo, canonical: false };
}

/** The row for `slug` in a parsed published index (`{ repos: [...] }`), if any. */
export function publishedRowForSlug(index: unknown, slug: string): Record<string, unknown> | undefined {
  const repos = (index as { repos?: unknown } | null | undefined)?.repos;
  if (!Array.isArray(repos)) return undefined;
  return repos.find(candidate => (candidate as { slug?: unknown } | null)?.slug === slug) as Record<string, unknown> | undefined;
}
