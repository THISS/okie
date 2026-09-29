/**
 * Display names of a published atlas (CLA-318). A published index row stores `owner` / `repo` as the
 * operator's scan named them (often lower-case: `burntsushi`), and, since CLA-318, GitHub's own casing
 * in `ownerLogin` / `repoName` (`BurntSushi`), recorded at publish time or by
 * `pnpm publish:atlas --backfill-names`. Shown text and GitHub links prefer GitHub's casing; canonical
 * URLs stay in slug form. Runtime-agnostic: the web app, the edge Worker and the Vite plugin share it.
 */
import { repoSlugFor } from './renderer/route';

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

/**
 * `/r/<slug owner>/<slug repo>` for an index row's slug when that slug maps straight back to itself
 * (the canonical share path the sitemap and the home directory link to); otherwise undefined, so a
 * malformed or hand-edited slug can never inject path text.
 */
export function canonicalAtlasPathForSlug(slug: unknown): string | undefined {
  if (typeof slug !== 'string') return undefined;
  const [owner, repo, ...extra] = slug.split('__');
  if (!owner || !repo || extra.length > 0 || repoSlugFor(owner, repo) !== slug) return undefined;
  return `/r/${owner}/${repo}`;
}

/**
 * An index row's timestamp field (`publishedAt`, `generatedAt`) as a normalized ISO string, or undefined
 * when it is not a parseable date string. Shared by the edge sitemap and the home directory.
 */
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
