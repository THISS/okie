/**
 * Clean-path routing for the hosted atlas (embed-hosting §1). The pathname picks
 * WHAT to load; all navigation state keeps riding the query (canonicalNavigationUrl
 * preserves the pathname untouched, so the two compose without new machinery).
 *
 *   /new                      → the paste-a-repo landing (scan submission)
 *   /r/<owner>/<repo>[/<ref>] → a scanned repository atlas by slug
 *   anything else             → the query-driven flows (golden demo, ?fixture=…)
 */

export type AppRoute =
  | { kind: "default" }
  | { kind: "landing" }
  | { kind: "repo"; owner: string; repo: string; ref?: string; slug: string };

/**
 * Mirror of the scanner's slug() (packages/scan/src/ids.ts) — the scanner is a
 * node-only package, so the browser derives <owner>__<repo> slugs with the same
 * rules rather than importing it. Keep the two in sync.
 */
export function scanSlug(text: string): string {
  const hyphenated = text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2");
  const cleaned = hyphenated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "x";
}

export function repoSlugFor(owner: string, repo: string): string {
  return `${scanSlug(owner)}__${scanSlug(repo)}`;
}

export function parseAppRoute(pathname: string): AppRoute {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 1 && segments[0] === "new") return { kind: "landing" };
  if (segments[0] === "r" && segments.length >= 3) {
    const owner = segments[1]!;
    const repo = segments[2]!;
    if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return { kind: "default" };
    const ref = segments.length > 3 ? segments.slice(3).join("/") : undefined;
    return {
      kind: "repo",
      owner,
      repo,
      ...(ref ? { ref } : {}),
      slug: repoSlugFor(owner, repo),
    };
  }
  return { kind: "default" };
}
