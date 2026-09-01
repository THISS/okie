import { createAnonymousGithubClient, type GithubClient, type GithubClientOptions } from "@okie/scan";

/**
 * GitHub identity for a hosted scan (CLA-30).
 *
 * Abuse-gate direction is Vercel-like GitHub auth: public trees scan with no
 * install and no login; private trees stay closed until a user/App identity
 * can read them. This PR wires only `anonymous`. The `github` variant is the
 * seam for OAuth / GitHub App installation tokens — still HTTPS Bearer, never
 * operator `gh`, never process-env `GITHUB_TOKEN` / `GH_TOKEN`.
 *
 * Anonymous POST /api/scans must not inherit the operator's GitHub credentials.
 */
export type ScanGithubAccess =
  | { kind: "anonymous" }
  | { kind: "github"; source: "oauth" | "app"; token: string };

export type ScanGithubAccessHeaders = {
  authorization?: string | string[] | undefined;
};

/**
 * Resolve GitHub identity for one HTTP scan request.
 *
 * First PR: always anonymous. Authorization headers, cookies, and operator
 * env tokens are ignored so a hosted paste cannot silently spend `gh` auth
 * or a machine `GITHUB_TOKEN`.
 */
export function resolveScanGithubAccess(
  _headers: ScanGithubAccessHeaders = {},
): ScanGithubAccess {
  return { kind: "anonymous" };
}

/**
 * Transport for that identity. Anonymous (and the unwired `github` seam)
 * uses HTTPS-only acquisition — `createAnonymousGithubClient` never shells
 * out to `gh`. A follow-up auth PR maps `access.kind === "github"` onto a
 * Bearer client here; until then the token is not sent, logged, or stored.
 */
export function githubClientForAccess(
  access: ScanGithubAccess,
  options: GithubClientOptions = {},
): GithubClient {
  void access;
  return createAnonymousGithubClient(options);
}
