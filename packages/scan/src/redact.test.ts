import assert from "node:assert/strict";
import test from "node:test";
import { scrubGithubTokens, scrubIdentifierValues, scrubProviderIdentifiers } from "./redact.js";

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

/** Fabricated identifiers shaped like an OpenRouter/OpenAI error body's account fields — never real. */
const FAKE_USER_ID = "user_2fAbCdEfGhIjKlMnOpQrStUv";
const FAKE_ORG = "org_fake123";
const FAKE_OPENAI_ORG = "org-AbCdEf1234567890";
const FAKE_EMAIL = "okie.fake.operator@example.invalid";
const FAKE_OR_KEY = "sk-or-v1-0000fakefakefakefakefakefake0000";
const leaks = (text: string, secrets: readonly string[]) => secrets.filter(secret => text.includes(secret));

test("scrubProviderIdentifiers removes provider account identifiers, keys, and emails and is idempotent", () => {
  const body = JSON.stringify({ error: { message: `Invalid model for ${FAKE_EMAIL}`, code: 400, metadata: { organization: FAKE_ORG } }, user_id: FAKE_USER_ID });
  const escaped = JSON.stringify({ message: body });
  const doubly = JSON.stringify({ message: escaped });
  const loose = `user_id=${FAKE_USER_ID} org_id: ${FAKE_ORG} api_key=${FAKE_OR_KEY} Authorization: Bearer abcdefgh12345678 ${PLANTED_GHO}`;
  for (const input of [body, escaped, doubly, loose]) {
    const scrubbed = scrubProviderIdentifiers(input);
    assert.deepEqual(leaks(scrubbed, [FAKE_USER_ID, FAKE_ORG, FAKE_EMAIL, FAKE_OR_KEY, "abcdefgh12345678", PLANTED_GHO]), [], scrubbed);
    assert.equal(scrubProviderIdentifiers(scrubbed), scrubbed);
  }
  assert.match(scrubProviderIdentifiers(body), /"user_id":"\[redacted\]"/);
  assert.equal(scrubProviderIdentifiers(`bare id ${FAKE_USER_ID} and key ${FAKE_OR_KEY}`), "bare id [redacted-id] and key [redacted-key]");
  assert.equal(scrubProviderIdentifiers("llm gateway 400: model not-a-real-model is not a valid model ID"), "llm gateway 400: model not-a-real-model is not a valid model ID");
  assert.equal(scrubProviderIdentifiers("user_settings, user_service2, org_chart and component:user:api stay"), "user_settings, user_service2, org_chart and component:user:api stay");
});

test("scrubProviderIdentifiers: OpenAI-style org ids, bare and after a whitespace separator", () => {
  const openai = `Rate limit reached for gpt-4o in organization ${FAKE_OPENAI_ORG} on tokens per min`;
  assert.equal(scrubProviderIdentifiers(openai), "Rate limit reached for gpt-4o in organization [redacted] on tokens per min");
  assert.equal(scrubProviderIdentifiers(`bare ${FAKE_OPENAI_ORG}.`), "bare [redacted-id].");
  assert.equal(scrubProviderIdentifiers("for user u-12345 and account acct9f8e7d"), "for user [redacted] and account [redacted]");
  assert.equal(scrubProviderIdentifiers("the org-administration team"), "the org-administration team");
  assert.equal(scrubProviderIdentifiers("in organization org-abcdefghijklmnopqrstuvwx now"), "in organization [redacted-id] now");
  assert.equal(scrubProviderIdentifiers("bare org-abcdefghijklmnopqrstuvwx, user-AbC123def456GhIjk, proj_AbCdEf1234567890xyz, user_2fabcdefghijklmnopqrstu"), "bare [redacted-id], [redacted-id], [redacted-id], [redacted-id]");
  assert.equal(scrubProviderIdentifiers("Account frozen for user bob.smith"), "Account frozen for user [redacted]");
});

test("scrubProviderIdentifiers: object values, prefixed keys, generic keys, spaced and escaped quoted values", () => {
  const object = scrubProviderIdentifiers(`{"organization":{"id":"${FAKE_ORG}","name":"Fake Org"},"ok":1}`);
  assert.equal(object, `{"organization":"[redacted]","ok":1}`);
  assert.deepEqual(JSON.parse(object), { organization: "[redacted]", ok: 1 });
  assert.equal(scrubProviderIdentifiers(`{"end_user_id":"abc","openrouter_user_id":"u1","customer-email":"x"}`), `{"end_user_id":"[redacted]","openrouter_user_id":"[redacted]","customer-email":"[redacted]"}`);
  assert.equal(scrubProviderIdentifiers(`{"user":"u-12345","role":"user"}`), `{"user":"[redacted]","role":"user"}`);
  assert.equal(scrubProviderIdentifiers(`{"user":"a person"}`), `{"user":"a person"}`, "generic `user` only when the value is id-shaped");
  assert.equal(scrubProviderIdentifiers(`{"organization":"Fake Org Name Ltd","code":400}`), `{"organization":"[redacted]","code":400}`);
  const doubly = JSON.stringify(JSON.stringify(JSON.stringify({ user_id: "spaced value 42", email: FAKE_EMAIL })));
  const scrubbed = scrubProviderIdentifiers(doubly);
  assert.deepEqual(leaks(scrubbed, ["spaced value 42", FAKE_EMAIL]), []);
  assert.deepEqual(JSON.parse(JSON.parse(JSON.parse(scrubbed) as string) as string), { user_id: "[redacted]", email: "[redacted]" });
});

test("scrubProviderIdentifiers keeps prose and structured ids that only look like keys", () => {
  assert.equal(scrubProviderIdentifiers("Invalid value for email: must be a string"), "Invalid value for email: must be a string");
  assert.equal(scrubIdentifierValues("component:email:sender"), "component:email:sender");
  assert.equal(scrubIdentifierValues(`component:email:sender ${FAKE_EMAIL}`), "component:email:sender [redacted-email]");
});

test("scrubProviderIdentifiers: strong keys lose any value, hyphenated keys match, numeric JSON values stay valid", () => {
  assert.equal(scrubProviderIdentifiers("user_id=johnsmith organization=acme-inc"), "user_id=[redacted] organization=[redacted]");
  assert.equal(scrubProviderIdentifiers(`{"account_id":4242,"user_id":12345678,"n":1}`), `{"account_id":"[redacted]","user_id":"[redacted]","n":1}`);
  assert.equal(scrubProviderIdentifiers("user-id=abc account-id: xyz api-key=abc123 X-User-Id: 98765432"), "user-id=[redacted] account-id: [redacted] api-key=[redacted] X-User-Id: [redacted]");
  assert.equal(scrubProviderIdentifiers(`{"User-Id":"abc"}`), `{"User-Id":"[redacted]"}`);
});

test("scrubProviderIdentifiers: quoted values end at the real closing quote at any escape depth", () => {
  const depth0 = String.raw`{"user_id":"abc\"secretTail123","ok":1}`;
  assert.equal(scrubProviderIdentifiers(depth0), `{"user_id":"[redacted]","ok":1}`);
  const depth1 = JSON.stringify({ message: JSON.parse(depth0) === undefined ? "" : depth0 });
  const scrubbed1 = scrubProviderIdentifiers(depth1);
  assert.equal(scrubbed1.includes("secretTail123"), false, scrubbed1);
  assert.deepEqual(JSON.parse(JSON.parse(scrubbed1).message as string), { user_id: "[redacted]", ok: 1 });
  const depth2 = JSON.stringify({ outer: depth1 });
  const scrubbed2 = scrubProviderIdentifiers(depth2);
  assert.equal(scrubbed2.includes("secretTail123"), false, scrubbed2);
  assert.deepEqual(JSON.parse(JSON.parse(JSON.parse(scrubbed2).outer as string).message as string), { user_id: "[redacted]", ok: 1 });
  // A value with an escaped backslash right before its closing quote.
  assert.equal(scrubProviderIdentifiers(String.raw`{"email":"a\\","ok":1}`), `{"email":"[redacted]","ok":1}`);
});

test("scrubProviderIdentifiers: long values and long email local parts are fully removed", () => {
  const long = "Z9".repeat(3000);
  for (const input of [`user_id=${long}`, `{"user_id":"${long}"}`, `{"organization":{"note":"${long}"}}`]) assert.equal(scrubProviderIdentifiers(input).includes("Z9Z9"), false);
  assert.equal(scrubProviderIdentifiers(`contact ${"a".repeat(200)}@example.invalid now`), "contact [redacted-email] now");
  const unclosed = scrubProviderIdentifiers(`{"user_id":"abc${long}`);
  assert.equal(unclosed.includes("Z9Z9"), false);
});

test("scrubProviderIdentifiers: braces inside strings do not swallow the rest; unbalanced objects stop at the field", () => {
  assert.equal(scrubProviderIdentifiers(`{"organization":{"name":"a}b{c","id":"x1"},"ok":1}`), `{"organization":"[redacted]","ok":1}`);
  assert.equal(scrubProviderIdentifiers(`organization={broken, then more text`), `organization="[redacted]", then more text`);
});

test("scrubProviderIdentifiers keeps valid JSON valid", () => {
  const shapes: unknown[] = [
    { error: { message: "bad", code: 400, metadata: { organization: { id: FAKE_ORG, tags: ["a}", "{b"] } } }, user_id: FAKE_USER_ID },
    { user_id: 12345678, account_id: null, email: FAKE_EMAIL, api_key: FAKE_OR_KEY, "X-User-Id": "u-1" },
    { organization: ["org one", { id: FAKE_ORG }], user: "u-12345", role: "user", note: `quote \" inside ${FAKE_EMAIL}` },
    [{ end_user_id: "a\\\"b" }, { "api-key": true }, { nested: JSON.stringify({ user_id: FAKE_USER_ID, organization: { x: 1 } }) }],
  ];
  for (const shape of shapes) {
    for (const text of [JSON.stringify(shape), JSON.stringify(shape, null, 2), JSON.stringify(JSON.stringify(shape))]) {
      const scrubbed = scrubProviderIdentifiers(text);
      assert.doesNotThrow(() => JSON.parse(scrubbed), scrubbed);
      assert.deepEqual(leaks(scrubbed, [FAKE_USER_ID, FAKE_ORG, FAKE_EMAIL, FAKE_OR_KEY]), [], scrubbed);
      assert.equal(scrubProviderIdentifiers(scrubbed), scrubbed);
    }
  }
});

test("scrubProviderIdentifiers stays linear on long unbroken runs", () => {
  for (const input of ["a".repeat(100_000), "a.".repeat(50_000), "a_".repeat(50_000), `${"x".repeat(100_000)}@`, "user_".repeat(20_000), `"email":"${"q".repeat(100_000)}`, `"user_id":{`.repeat(10_000), `"user":"`.repeat(10_000), `${"\\".repeat(50_000)}"`]) {
    const started = performance.now();
    scrubProviderIdentifiers(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `${elapsed.toFixed(0)}ms on ${input.slice(0, 12)}…`);
  }
});
