# Operator access contract

`apps/server/src/operatorAccess.ts` is the route-level contract for draft, retry, and publication mutations.

Set `OKIE_OPERATOR_GITHUB_IDS` to a comma-separated list of stable, positive numeric GitHub account IDs. The whole setting fails closed when empty or malformed. GitHub logins, access tokens, PATs, `Authorization` headers, and an arbitrary `Host` header never establish operator access.

Routes obtain the identity only from `GithubAuthService.sessionFromRequest`. `authorizeOperator` returns `401` for no session and `403` for a signed-in non-operator. Routes should return generic authorization errors and must not serialize the configured allowlist. Browser auth/config responses can use `publicOperatorAccessView`, which exposes only `{ operator: boolean }`.

Cookie-authenticated operator mutations must call `authorizeOperatorMutation` with the explicit configured public origin (`GithubAuthService.config.publicOrigin` is the intended source). The helper requires an exact `Origin` match and deliberately ignores `Host`, `X-Forwarded-Host`, and `Forwarded`; this remains safe behind a reverse proxy because the expected origin is deployment configuration, not request metadata. Missing or malformed Origins are rejected for mutations. Public read routes do not call this guard.
