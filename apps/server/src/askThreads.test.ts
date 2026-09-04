import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ASK_THREAD_TURNS,
  askAtlasIdentityFromSearch,
  createAskThreadStore,
  emptyPublicAskThread,
  persistAskTurn,
  publicAskThread,
  sanitizeAskAtlasIdentity,
} from "./askThreads.js";

const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla69-fake";
const PLANTED_TOKEN = "gho_okieTestPlantedSecretCla69xxxx";
const ATLAS = { owner: "THISS", repo: "okie", commitSha: "abc123def456" };

test("atlas identity accepts GitHub owner/repo + commitSha and rejects junk", () => {
  assert.deepEqual(sanitizeAskAtlasIdentity(ATLAS), ATLAS);
  assert.equal(sanitizeAskAtlasIdentity({ owner: "acme", repo: "widgets", commitSha: "golden-worktree-okie-2026-07-14-v1" })?.commitSha, "golden-worktree-okie-2026-07-14-v1");
  assert.equal(sanitizeAskAtlasIdentity({ owner: "../etc", repo: "okie", commitSha: "abc" }), undefined);
  assert.equal(sanitizeAskAtlasIdentity({ owner: "THISS", repo: "okie", commitSha: "" }), undefined);
  assert.equal(sanitizeAskAtlasIdentity({ owner: "THISS", repo: "ok ie", commitSha: "abc" }), undefined);
  assert.deepEqual(
    askAtlasIdentityFromSearch(new URLSearchParams("owner=THISS&repo=okie&commitSha=abc123def456")),
    ATLAS,
  );
});

test("threads are isolated per GitHub user and atlas identity", () => {
  const store = createAskThreadStore();
  persistAskTurn(store, "1", ATLAS, {
    question: "What is Okie?",
    answer: "A spatial atlas.",
    citations: ["system:okie"],
    scopeIds: ["system:okie"],
  }, undefined);
  persistAskTurn(store, "1", { ...ATLAS, commitSha: "other" }, {
    question: "Other map?",
    answer: "Different commit.",
    citations: [],
    scopeIds: [],
  }, undefined);
  persistAskTurn(store, "2", ATLAS, {
    question: "Other user?",
    answer: "Not yours.",
    citations: [],
    scopeIds: [],
  }, undefined);

  const mine = store.get("1", ATLAS);
  assert.equal(mine?.turns.length, 1);
  assert.equal(mine?.turns[0]?.question, "What is Okie?");
  assert.equal(store.get("1", { ...ATLAS, commitSha: "other" })?.turns[0]?.answer, "Different commit.");
  assert.equal(store.get("2", ATLAS)?.turns[0]?.question, "Other user?");
  assert.equal(store.get("1", { owner: "acme", repo: "widgets", commitSha: ATLAS.commitSha }), undefined);
});

test("public thread never includes userId, tokens, or the gateway key", () => {
  const store = createAskThreadStore();
  const thread = persistAskTurn(store, "42", ATLAS, {
    question: `What about ${PLANTED_TOKEN} and ${FAKE_GATEWAY_KEY}?`,
    answer: `Uses ${FAKE_GATEWAY_KEY} and ${PLANTED_TOKEN} in the shell.`,
    citations: ["container:web-app"],
    scopeIds: ["container:web-app"],
  }, FAKE_GATEWAY_KEY);
  const published = publicAskThread(thread);
  const json = JSON.stringify(published);
  assert.equal("userId" in published, false);
  assert.equal("token" in published, false);
  assert.equal("apiKey" in published, false);
  assert.doesNotMatch(json, new RegExp(FAKE_GATEWAY_KEY));
  assert.doesNotMatch(json, new RegExp(PLANTED_TOKEN));
  assert.match(published.turns[0]!.answer, /\[redacted-llm-key\]/);
  assert.deepEqual(emptyPublicAskThread(ATLAS).turns, []);
});

test("thread length is capped so one user cannot grow unbounded", () => {
  const store = createAskThreadStore();
  for (let index = 0; index < MAX_ASK_THREAD_TURNS + 8; index += 1) {
    persistAskTurn(store, "1", ATLAS, {
      question: `Q${index}`,
      answer: `A${index}`,
      citations: [],
      scopeIds: [],
    }, undefined);
  }
  const thread = store.get("1", ATLAS);
  assert.equal(thread?.turns.length, MAX_ASK_THREAD_TURNS);
  assert.equal(thread?.turns[0]?.question, "Q8");
  assert.equal(thread?.turns.at(-1)?.question, `Q${MAX_ASK_THREAD_TURNS + 7}`);
});
