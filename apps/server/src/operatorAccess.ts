import type { IncomingMessage } from "node:http";
import type { GithubSession } from "./githubOAuth.js";

/** Result suitable for an operator-only HTTP route. Never includes the configured allowlist. */
export type OperatorAuthorization =
  | { authorized: true; session: GithubSession }
  | { authorized: false; status: 401 | 403; reason: "unsigned" | "not-operator" };

/** Safe to include in a browser auth/config response; never exposes account ids. */
export type PublicOperatorAccessView = { operator: boolean };

/**
 * Stable GitHub numeric account ids explicitly permitted to operate draft and
 * publication routes. A malformed list fails closed rather than accidentally
 * interpreting a login name, token, or partial value as an operator id.
 */
export function resolveOperatorGithubIds(env: NodeJS.Dict<string> = process.env): ReadonlySet<string> {
  const raw = env.OKIE_OPERATOR_GITHUB_IDS;
  if (!raw || !raw.trim()) return new Set();

  const values = raw.split(",").map(value => value.trim());
  if (values.some(value => !/^[1-9][0-9]*$/.test(value))) return new Set();
  return new Set(values);
}

/**
 * Only a verified GitHub session can establish an operator identity. In
 * particular, callers must not derive this result from a bearer/PAT header.
 */
export function authorizeOperator(
  session: GithubSession | undefined,
  allowedGithubIds: ReadonlySet<string>,
): OperatorAuthorization {
  if (!session) return { authorized: false, status: 401, reason: "unsigned" };
  if (!allowedGithubIds.has(session.userId)) {
    return { authorized: false, status: 403, reason: "not-operator" };
  }
  return { authorized: true, session };
}

export function publicOperatorAccessView(authorization: OperatorAuthorization): PublicOperatorAccessView {
  return { operator: authorization.authorized };
}

export interface OperatorMutationSecurityConfig {
  /** Explicit deployment origin, e.g. the configured `OKIE_PUBLIC_ORIGIN`. */
  publicOrigin: string;
}

function configuredOrigin(config: OperatorMutationSecurityConfig): string | undefined {
  try {
    const url = new URL(config.publicOrigin);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF guard for cookie-authenticated operator mutations. It compares the
 * browser Origin with an explicitly configured public origin. It intentionally
 * ignores Host, X-Forwarded-Host, and Forwarded, which a reverse proxy may
 * carry from an untrusted request unless the application has separately
 * established a trusted-proxy boundary.
 */
export function hasConfiguredSameOrigin(
  request: Pick<IncomingMessage, "headers">,
  config: OperatorMutationSecurityConfig,
): boolean {
  const expected = configuredOrigin(config);
  const origin = request.headers.origin;
  if (!expected || Array.isArray(origin) || typeof origin !== "string") return false;
  try {
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

/**
 * Route-ready guard: authorization first, then CSRF for a cookie-authenticated
 * mutation. Public read routes should not call this helper.
 */
export function authorizeOperatorMutation(input: {
  request: Pick<IncomingMessage, "headers">;
  session: GithubSession | undefined;
  allowedGithubIds: ReadonlySet<string>;
  security: OperatorMutationSecurityConfig;
}): OperatorAuthorization | { authorized: false; status: 403; reason: "csrf" } {
  const authorization = authorizeOperator(input.session, input.allowedGithubIds);
  if (!authorization.authorized) return authorization;
  if (!hasConfiguredSameOrigin(input.request, input.security)) {
    return { authorized: false, status: 403, reason: "csrf" };
  }
  return authorization;
}
