import assert from "node:assert/strict";
import test from "node:test";
import { scrubGithubTokens } from "./redact.js";

/** Obviously fake — never a live credential. Matches the existing `gh*` / `github_pat_` patterns. */
const PLANTED_GHO = "gho_okieTestPlantedSecretCla25xxxx";
const PLANTED_GHP = "ghp_okieTestPlantedSecretCla25xxxx";
const PLANTED_PAT = "github_pat_okieTestPlantedSecretCla25xxxx";

test("scrubGithubTokens redacts gh- and github_pat-shaped tokens and is idempotent", () => {
  assert.equal(scrubGithubTokens(`auth ${PLANTED_GHO}`), "auth [redacted-token]");
  assert.equal(scrubGithubTokens(`auth ${PLANTED_GHP}`), "auth [redacted-token]");
  assert.equal(scrubGithubTokens(`auth ${PLANTED_PAT}`), "auth [redacted-token]");
  assert.equal(scrubGithubTokens("no secrets here"), "no secrets here");
  assert.equal(scrubGithubTokens("auth [redacted-token]"), "auth [redacted-token]");
  assert.doesNotMatch(scrubGithubTokens(PLANTED_GHO), /gho_/);
});
