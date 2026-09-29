import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ASK_THREAD_TURNS,
  MAX_ASK_TURN_CITATION_DETAILS,
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

test("turns keep bounded, scrubbed citation details and a compact retrieval summary (CLA-265)", () => {
  const store = createAskThreadStore();
  const details = Array.from({ length: MAX_ASK_TURN_CITATION_DETAILS + 5 }, (_, index) => ({
    id: `code:item-${index}`,
    name: index === 0 ? `leaks ${PLANTED_TOKEN} ${FAKE_GATEWAY_KEY}` : `item${index}`,
    kind: "code",
    path: `src/item${index}.ts`,
    startLine: index === 1 ? 0 : 3,
    endLine: index === 2 ? 1 : 9,
  }));
  const thread = persistAskTurn(store, "7", ATLAS, {
    question: "Where?",
    answer: "Here.",
    citations: ["code:item-0"],
    scopeIds: ["code:item-0"],
    citationDetails: [...details, { ...details[3]! }],
    retrieval: { mode: "atlas", searchedWholeAtlas: true, selectedScopeIds: ["system:okie", ...Array.from({ length: 80 }, (_, index) => `container:c${index}`)], sectionCount: 12, bytes: 18_000.7, retrievedScopeIds: ["code:item-0", "code:item-0"] },
  }, FAKE_GATEWAY_KEY);
  const turn = publicAskThread(thread).turns[0]!;
  assert.equal(turn.citationDetails?.length, MAX_ASK_TURN_CITATION_DETAILS);
  assert.doesNotMatch(JSON.stringify(turn), new RegExp(`${PLANTED_TOKEN}|${FAKE_GATEWAY_KEY}`));
  assert.equal(turn.citationDetails?.[1]?.startLine, undefined);
  assert.equal(turn.citationDetails?.[2]?.endLine, undefined);
  assert.deepEqual(turn.citationDetails?.[3], { id: "code:item-3", name: "item3", kind: "code", path: "src/item3.ts", startLine: 3, endLine: 9 });
  assert.equal(turn.retrieval?.selectedScopeIds.length, 64);
  assert.equal(turn.retrieval?.selectedScopeIds[0], "system:okie");
  assert.deepEqual({ ...turn.retrieval, selectedScopeIds: [] }, { mode: "atlas", searchedWholeAtlas: true, selectedScopeIds: [], sectionCount: 12, bytes: 18_000, retrievedScopeIds: ["code:item-0"] });

  // Turns stored before CLA-265 (no details / retrieval) still load unchanged.
  const legacy = persistAskTurn(store, "8", ATLAS, { question: "Old?", answer: "Yes.", citations: [], scopeIds: [] }, undefined);
  const legacyTurn = publicAskThread(legacy).turns[0]!;
  assert.equal("citationDetails" in legacyTurn, false);
  assert.equal("retrieval" in legacyTurn, false);
});
