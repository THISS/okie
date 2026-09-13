import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeOperator,
  authorizeOperatorMutation,
  hasConfiguredSameOrigin,
  publicOperatorAccessView,
  resolveOperatorGithubIds,
} from "./operatorAccess.js";
import type { GithubSession } from "./githubOAuth.js";

const session: GithubSession = {
  id: "session-1",
  login: "octocat",
  userId: "12345",
  source: "oauth",
  token: "gho_not_used_by_operator_access",
  createdAt: 1,
};

const request = (headers: Record<string, string | string[] | undefined>) => ({ headers });

test("operator allowlist uses stable numeric GitHub ids and malformed configuration fails closed", () => {
  assert.deepEqual([...resolveOperatorGithubIds({ OKIE_OPERATOR_GITHUB_IDS: "123, 456,123" })], ["123", "456"]);
  assert.equal(resolveOperatorGithubIds({}).size, 0);
  assert.equal(resolveOperatorGithubIds({ OKIE_OPERATOR_GITHUB_IDS: "" }).size, 0);
  assert.equal(resolveOperatorGithubIds({ OKIE_OPERATOR_GITHUB_IDS: "123, octocat" }).size, 0);
  assert.equal(resolveOperatorGithubIds({ OKIE_OPERATOR_GITHUB_IDS: "123,,456" }).size, 0);
  assert.equal(resolveOperatorGithubIds({ OKIE_OPERATOR_GITHUB_IDS: "0" }).size, 0);
});

test("operator authorization distinguishes unsigned and signed non-operator callers", () => {
  const allow = new Set(["12345"]);
  assert.deepEqual(authorizeOperator(undefined, allow), { authorized: false, status: 401, reason: "unsigned" });
  assert.deepEqual(authorizeOperator({ ...session, userId: "999" }, allow), {
    authorized: false, status: 403, reason: "not-operator",
  });
  assert.equal(authorizeOperator(session, allow).authorized, true);
  assert.deepEqual(publicOperatorAccessView(authorizeOperator(session, allow)), { operator: true });
  assert.doesNotMatch(JSON.stringify(publicOperatorAccessView(authorizeOperator(session, allow))), /12345|octocat|token/i);
});

test("a bearer or PAT header without a verified session cannot grant operator access", () => {
  const result = authorizeOperatorMutation({
    request: request({ authorization: "Bearer ghp_operator_pat" }),
    session: undefined,
    allowedGithubIds: new Set(["12345"]),
    security: { publicOrigin: "https://okie.example" },
  });
  assert.deepEqual(result, { authorized: false, status: 401, reason: "unsigned" });
});

test("mutation CSRF uses configured public origin and ignores Host plus forwarded host headers", () => {
  const security = { publicOrigin: "https://okie.example" };
  assert.equal(hasConfiguredSameOrigin(request({
    origin: "https://okie.example",
    host: "attacker.example",
    "x-forwarded-host": "attacker.example",
    forwarded: "host=attacker.example",
  }), security), true);
  assert.equal(hasConfiguredSameOrigin(request({
    origin: "https://attacker.example",
    host: "okie.example",
    "x-forwarded-host": "okie.example",
  }), security), false);
  assert.equal(hasConfiguredSameOrigin(request({ host: "okie.example" }), security), false);
  assert.equal(hasConfiguredSameOrigin(request({ origin: ["https://okie.example"] }), security), false);
});

test("operator mutations require same-origin browser requests after operator authorization", () => {
  const input = {
    session,
    allowedGithubIds: new Set(["12345"]),
    security: { publicOrigin: "https://okie.example" },
  };
  assert.deepEqual(authorizeOperatorMutation({ ...input, request: request({ origin: "https://attacker.example" }) }), {
    authorized: false,
    status: 403,
    reason: "csrf",
  });
  assert.equal(authorizeOperatorMutation({ ...input, request: request({ origin: "https://okie.example" }) }).authorized, true);
});
