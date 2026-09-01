import {
  createAnonymousGithubClient,
  createBearerGithubClient,
  type GithubClient,
  type GithubClientOptions,
} from "@okie/scan";
import type { GithubIdentitySource, GithubSession } from "./githubOAuth.js";

/**
 * GitHub identity for a hosted scan (CLA-30).
 *
 * Abuse gate is Vercel-like GitHub auth: no session, no scan. Public atlas
 * *views* stay login-free. Private trees wait on this identity (OAuth user
 * token now; App installation tokens are a follow-up mint).
 *
 * Tokens are HTTPS Bearer only — never operator `gh`, never process-env
 * `GITHUB_TOKEN` / `GH_TOKEN`, never a request `Authorization` header.
 */

export type ScanGithubAccess =
  | { kind: "unauthenticated" }
  | {
    kind: "github";
    source: GithubIdentitySource;
    token: string;
    login: string;
    userId: string;
  };

export type ScanGithubAccessHeaders = {
  authorization?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
};

export const HOSTED_SCAN_AUTH_ERROR =
  "Sign in with GitHub to scan a repository. Viewing a published atlas at /r/owner/repo stays public — there is no login wall on the map.";

/**
 * Resolve GitHub identity for one HTTP scan request.
 *
 * Session cookie is the only grant. Request `Authorization` headers and
 * operator env tokens are ignored so a hosted POST cannot silently spend
 * `gh` auth or a machine `GITHUB_TOKEN`.
 */
export function resolveScanGithubAccess(input: {
  session?: GithubSession;
  headers?: ScanGithubAccessHeaders;
} = {}): ScanGithubAccess {
  void input.headers;
  const session = input.session;
  if (session?.login && session.userId && session.token) {
    return {
      kind: "github",
      source: session.source,
      token: session.token,
      login: session.login,
      userId: session.userId,
    };
  }
  return { kind: "unauthenticated" };
}

/**
 * Transport for that identity. OAuth/App tokens go on HTTPS Bearer.
 * Test-double sessions never send their placeholder token to GitHub (public
 * HTTPS only). Unauthenticated access throws — the HTTP handler 401s first.
 */
export function githubClientForAccess(
  access: ScanGithubAccess,
  options: GithubClientOptions = {},
): GithubClient {
  if (access.kind !== "github") {
    throw new Error("hosted scan requires GitHub sign-in");
  }
  if (access.source === "test-double") {
    return createAnonymousGithubClient(options);
  }
  return createBearerGithubClient(access.token, options);
}

export function scanQuotaKey(access: ScanGithubAccess): string {
  if (access.kind === "github") return `gh:${access.userId}`;
  return "unauthenticated";
}
