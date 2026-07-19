import { parseGithubSource, type GithubSourceRef } from "@okie/scan";

/**
 * Normalizes the free-form repository input a user pastes into the landing form
 * onto the scanner's canonical `gh:owner/repo[@ref]` source. Accepted shapes:
 *
 *   https://github.com/owner/repo            (optional .git, trailing slash)
 *   https://github.com/owner/repo/tree/ref   (branch/tag/sha pin)
 *   github.com/owner/repo                    (scheme omitted)
 *   owner/repo[@ref]                         (bare)
 *   gh:owner/repo[@ref]                      (the CLI form)
 *
 * Everything funnels through the scanner's own parseGithubSource so the server
 * can never accept an identity the pipeline would reject. Returns undefined for
 * anything else (non-GitHub hosts are out of scope for the public scan surface).
 */
export function normalizeRepoInput(input: string): GithubSourceRef | undefined {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  if (trimmed.startsWith("gh:")) return parseGithubSource(trimmed);

  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@(.+))?$/.exec(trimmed);
  if (bare && !trimmed.includes(".com") && !trimmed.includes("://")) {
    const [, owner, repo, ref] = bare;
    return parseGithubSource(`gh:${owner}/${repo}${ref ? `@${ref}` : ""}`);
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  // /tree/<ref>/... and /commit/<sha> pin the scan; deeper paths (blob, issues…) are ignored.
  const ref = (segments[2] === "tree" || segments[2] === "commit") && segments[3]
    ? segments.slice(3).join("/")
    : undefined;
  return parseGithubSource(`gh:${owner}/${repo}${ref ? `@${ref}` : ""}`);
}
