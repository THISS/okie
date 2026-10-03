import assert from "node:assert/strict";
import test from "node:test";
import type { ArchitectureEntity, ArchitectureSnapshot, SourceExcerpt } from "./model.js";
import { AGENT_QUERY_LIMITS, agentEntity, agentEvidence, agentPublicText, agentRelations, agentRepositoryPath, agentSearch } from "./agentQueries.js";

function entity(id: string, parentId?: string): ArchitectureEntity {
  return { id, kind: "component", name: "Query service", ...(parentId ? { parentId } : {}), sourceRefs: [{ path: `src/${id}.ts`, commitSha: "abc123", startLine: 1, endLine: 3 }], responsibility: "Answers deterministic queries." };
}
function snapshot(entities: ArchitectureEntity[] = [entity("query")]): ArchitectureSnapshot {
  return { schemaVersion: 1, id: "snapshot:1", repositoryId: "owner/repo", commitSha: "abc123", generatedAt: "2026-10-01T00:00:00Z", entities, relations: [] };
}
function excerpt(): SourceExcerpt {
  return { path: "src/query.ts", language: "typescript", startLine: 1, endLine: 2, highlightLine: 1, frozenRevision: "abc123", lines: ["export function query() {", "  return [];"], text: "export function query() {\n  return [];" };
}

test("public entity output is an explicit allowlist with honest unknown explanation provenance", () => {
  const row = entity("query");
  Object.assign(row, { privatePrompt: "PRIVATE_INTERNAL_PROMPT", metadata: { localRoot: "/Users/private/repo" }, confidence: 1, owners: ["private@example.org"] });
  Object.assign(row.sourceRefs[0]!, { filesystemPath: "/Users/private/repo/src/query.ts" });
  const source = snapshot([row]);
  Object.assign(source, { privateManifest: "PRIVATE_MANIFEST" });
  const result = agentEntity(source, "query");
  assert.deepEqual(result, {
    snapshotId: "snapshot:1", commitSha: "abc123", found: true,
    entity: { id: "query", kind: "component", name: "Query service", sourceRefs: [{ path: "src/query.ts", commitSha: "abc123", startLine: 1, endLine: 3 }], structureProvenance: "snapshot-recorded", technology: [], responsibility: "Answers deterministic queries.", explanationProvenance: "origin-not-recorded" },
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Users|private@|confidence|owners/);
  delete row.responsibility;
  assert.equal(agentEntity(source, "query").entity?.explanationProvenance, "missing");
  assert.equal(agentEntity(source, "absent").found, false);
});

test("search ranks names ahead of source-only hits, uses deterministic ties, and confines descendants", () => {
  const root = entity("root"); root.name = "Root";
  const named = entity("a", "root"); named.name = "Query";
  const tied = entity("b", "root"); tied.name = "Query";
  const pathOnly = entity("c", "root"); pathOnly.name = "Storage"; pathOnly.responsibility = "Storage"; pathOnly.sourceRefs[0]!.path = "src/query.ts";
  const outside = entity("outside"); outside.name = "Query";
  const source = snapshot([outside, pathOnly, tied, root, named]);
  assert.deepEqual(agentSearch(source, { query: "query", rootEntityId: "root" }).items.map(row => row.id), ["a", "b", "c"]);
  assert.deepEqual(agentSearch(source, { query: " query ", rootEntityId: "root" }), agentSearch({ ...source, entities: [...source.entities].reverse() }, { query: "query", rootEntityId: "root" }));
  // Malformed parent cycles cannot make root traversal loop forever.
  root.parentId = "b";
  assert.equal(agentSearch(source, { query: "query", rootEntityId: "root" }).items.length, 3);
  assert.equal(agentSearch(source, { query: "query", rootEntityId: "missing" }).error, "entity-not-found");
});

test("search pages without omissions and refuses cursors from another snapshot, query or root", () => {
  const source = snapshot(Array.from({ length: 117 }, (_, index) => entity(`item-${String(index).padStart(3, "0")}`)));
  const first = agentSearch(source, { query: "query", limit: 500 });
  assert.equal(first.items.length, AGENT_QUERY_LIMITS.maxLimit);
  assert.ok(first.nextCursor);
  const second = agentSearch(source, { query: "query", limit: 50, cursor: first.nextCursor });
  assert.ok(second.nextCursor);
  const third = agentSearch(source, { query: "query", limit: 50, cursor: second.nextCursor });
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(row => row.id)).size, 117);
  assert.equal(third.nextCursor, undefined);
  for (const changed of [{ ...source, id: "snapshot:2" }, { ...source, commitSha: "new-revision" }]) {
    assert.equal(agentSearch(changed, { query: "query", cursor: first.nextCursor }).error, "invalid-cursor");
  }
  assert.equal(agentSearch(source, { query: "storage", cursor: first.nextCursor }).error, "invalid-cursor");
  assert.equal(agentSearch(source, { query: "query", rootEntityId: source.entities[0]!.id, cursor: first.nextCursor }).error, "invalid-cursor");
  assert.equal(agentSearch(source, { query: "query", cursor: "%broken" }).error, "invalid-cursor");
  assert.equal(agentSearch(source, { query: " " }).error, "invalid-query");
  assert.equal(agentSearch(source, { query: "a".repeat(257) }).error, "invalid-query");
});

test("relations include both directions, have snapshot-bound pages and omit unknown properties", () => {
  const source = snapshot([entity("query"), entity("other")]);
  source.relations = [
    { id: "out", from: "query", to: "other", kind: "calls", label: "Calls", evidence: [{ source: { path: "src/query.ts", commitSha: "abc123" }, reason: "private planner context" }] },
    { id: "in", from: "other", to: "query", kind: "uses", evidence: [] },
    { id: "unrelated", from: "other", to: "other", kind: "calls", evidence: [] },
  ];
  Object.assign(source.relations[0]!, { privateDraft: "DO_NOT_EXPORT", confidence: 1 });
  const first = agentRelations(source, { entityId: "query", limit: 1 });
  assert.deepEqual(first.items.map(row => row.id), ["in"]);
  assert.ok(first.nextCursor);
  const second = agentRelations(source, { entityId: "query", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.id), ["out"]);
  assert.deepEqual(second.items[0]!.evidence, [{ path: "src/query.ts", commitSha: "abc123" }]);
  assert.doesNotMatch(JSON.stringify(second), /private|DO_NOT_EXPORT|confidence/);
  assert.equal(agentRelations(source, { entityId: "other", cursor: first.nextCursor }).error, "invalid-cursor");
  assert.equal(agentRelations(source, { entityId: "missing" }).found, false);
});

test("snapshot-qualified cursors remain usable for bounded Unicode snapshot and entity ids", () => {
  const root = "界".repeat(512);
  const source = snapshot([entity(root), entity("child", root)]);
  source.id = "界".repeat(512);
  const first = agentSearch(source, { query: "query", rootEntityId: root, limit: 1 });
  assert.ok(first.nextCursor);
  const next = agentSearch(source, { query: "query", rootEntityId: root, limit: 1, cursor: first.nextCursor });
  assert.equal(next.error, undefined);
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]!.id, first.items[0]!.id);
});

test("evidence distinguishes missing captures from missing entities without inventing scan coverage", () => {
  const source = snapshot();
  assert.deepEqual(agentEvidence(source, "missing"), { snapshotId: "snapshot:1", commitSha: "abc123", found: false, status: "entity-not-found", scanCoverage: "unknown", sourceRefs: [], excerpts: [], truncated: false });
  assert.equal(agentEvidence(source, "query").status, "not-captured");
  source.entities[0]!.sourceRefs = [];
  assert.equal(agentEvidence(source, "query").status, "no-source-reference");
  source.entities[0]!.sourceExcerpts = [excerpt()];
  const result = agentEvidence(source, "query");
  assert.equal(result.status, "captured");
  assert.equal(result.scanCoverage, "unknown");
  assert.equal(result.excerpts[0]!.text, excerpt().text);
  assert.equal(result.excerpts[0]!.partial, false);
});

test("source paths reject absolute, traversal, encoded and URL paths", () => {
  for (const path of ["/Users/private/a.ts", "C:\\private\\a.ts", "../a.ts", "src/../a.ts", "src//a.ts", "./src/a.ts", "src/%2e%2e/a.ts", "https://example.org/a.ts", "src/a.ts?secret=value", "src/a\u0000.ts"]) {
    assert.equal(agentRepositoryPath(path), undefined, path);
  }
  assert.equal(agentRepositoryPath("apps/web/src/ask.ts"), "apps/web/src/ask.ts");
  const source = snapshot();
  source.entities[0]!.sourceRefs.push({ path: "/Users/private/a.ts", commitSha: "abc123" });
  source.entities[0]!.sourceExcerpts = [{ ...excerpt(), path: "../private.ts" }];
  const result = agentEvidence(source, "query");
  assert.equal(result.excerpts.length, 0);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /Users|private/);
});

test("untrusted prose and captures redact credential and host-path shapes with bounded output", () => {
  const source = snapshot();
  const row = source.entities[0]!;
  const token = `ghp_${"a".repeat(36)}`;
  row.name = `Query ${token}`;
  row.responsibility = `From /Users/brenton/private/repo, api_key="secret-value"; ${"x".repeat(2000)}`;
  row.sourceExcerpts = [{ ...excerpt(), lines: [`const key = "${token}";`, 'const home = "/Users/brenton/private";'], text: "DO_NOT_TRUST_TEXT_FIELD", privatePrompt: "INTERNAL" } as SourceExcerpt];
  const detail = agentEntity(source, "query");
  assert.ok(detail.entity!.responsibility!.length <= AGENT_QUERY_LIMITS.maxExplanationCharacters);
  const captured = agentEvidence(source, "query");
  assert.match(captured.excerpts[0]!.text, /redacted-token/);
  assert.doesNotMatch(JSON.stringify([detail, captured]), /ghp_|secret-value|Users|brenton|DO_NOT_TRUST|INTERNAL/);
});

test("captures are bounded and mark omitted lines or observed original ranges as partial", () => {
  const source = snapshot();
  source.entities[0]!.sourceExcerpts = Array.from({ length: 10 }, (_, index) => ({ ...excerpt(), path: `src/${index}.ts`, endLine: 100, sourceStartLine: 1, sourceEndLine: 200, lines: Array.from({ length: 100 }, () => "x".repeat(1000)), text: "ignored" }));
  const result = agentEvidence(source, "query");
  assert.equal(result.excerpts.length, AGENT_QUERY_LIMITS.maxExcerpts);
  assert.equal(result.truncated, true);
  for (const captured of result.excerpts) {
    assert.ok(captured.text.length <= 4096);
    assert.ok(captured.text.split("\n").every(line => line.length <= 512));
    assert.ok(captured.endLine - captured.startLine + 1 <= 48);
    assert.equal(captured.partial, true);
  }
});

test("selector results are detached from the source snapshot", () => {
  const source = snapshot(); source.entities[0]!.sourceExcerpts = [excerpt()];
  const before = JSON.stringify(source);
  const detail = agentEntity(source, "query").entity!;
  detail.sourceRefs[0]!.path = "changed.ts";
  detail.technology.push("changed");
  const evidence = agentEvidence(source, "query"); evidence.excerpts[0]!.text = "changed";
  assert.equal(JSON.stringify(source), before);
});

test("published explanation adds bounded understanding and search topics without leaking operator data", () => {
  const source = snapshot(); delete source.entities[0]!.responsibility;
  const row = {
    entityId: "query", scopeId: "scope:query", state: "accepted", stale: false, explanationVersionId: "explanation:1",
    privatePrompt: "PRIVATE_PROMPT", metrics: { token: "PRIVATE_METRIC" },
    explanation: { format: "v3", summary: "Coordinates browser navigation and spatial storytelling.", keyPoints: ["Guided playback follows deterministic camera paths.", { private: "PRIVATE_OBJECT" }],
      evidence: [{ entityId: "query", path: "src/query.ts", symbol: "query", startLine: 1, endLine: 2, privateFile: "/Users/private" }, { entityId: "unknown", path: "../secret.ts" }],
      diagram: "PRIVATE_DIAGRAM", claims: [{ rawPrompt: "PRIVATE_CLAIM" }], table: { raw: "PRIVATE_TABLE" },
    },
  };
  const result = agentEntity(source, "query", row);
  assert.equal(result.entity?.responsibility, undefined);
  assert.equal(result.entity?.explanationProvenance, "origin-not-recorded");
  assert.deepEqual(result.entity?.understanding, {
    format: "v3", summary: row.explanation.summary, keyPoints: ["Guided playback follows deterministic camera paths."],
    evidence: [{ entityId: "query", path: "src/query.ts", symbol: "query", startLine: 1, endLine: 2 }],
    state: "accepted", stale: false, provenance: "published-explanation", origin: "origin-not-recorded", explanationVersionId: "explanation:1",
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Users|secret|metrics|rawPrompt/);
  assert.equal(agentSearch(source, { query: "spatial storytelling" }).items.length, 0);
  const explanations = new Map<string, unknown>([["query", row], ["unsupported-graph-id", { ...row, entityId: "unsupported-graph-id" }]]);
  assert.deepEqual(agentSearch(source, { query: "spatial storytelling", explanations }).items.map(item => item.id), ["query"]);
  assert.deepEqual(agentSearch(source, { query: "camera paths", explanations }).items.map(item => item.id), ["query"]);
});

test("stale published understanding remains explicitly stale, with unknown origin and missing fallback", () => {
  const source = snapshot(); delete source.entities[0]!.responsibility;
  const row = { entityId: "query", state: "accepted", stale: true, explanation: { summary: "Legacy account gateway.", roleWithinParent: "Coordinates accounts", interactions: ["Calls identity service"], evidence: [] } };
  const result = agentEntity(source, "query", row);
  assert.equal(result.entity?.understanding?.stale, true);
  assert.equal(result.entity?.understanding?.origin, "origin-not-recorded");
  assert.equal(result.entity?.understanding?.format, "legacy");
  assert.equal(result.entity?.understanding?.roleWithinParent, "Coordinates accounts");
  assert.deepEqual(result.entity?.understanding?.interactions, ["Calls identity service"]);
  for (const invalid of [undefined, { ...row, state: "running" }, { ...row, entityId: "other" }, { ...row, explanation: { ...row.explanation, format: "v99" } }]) {
    const detail = agentEntity(source, "query", invalid).entity!;
    assert.equal(detail.understanding, undefined);
    assert.equal(detail.explanationProvenance, "missing");
    assert.equal(detail.responsibility, undefined);
  }
  assert.equal(agentEntity(source, "query", { ...row, stale: undefined }).entity?.understanding?.stale, "unknown");
});

test("explanation projection bounds prose and evidence and scrubs known private shapes", () => {
  const source = snapshot();
  const row = { entityId: "query", state: "accepted", stale: false, explanation: {
    format: "v3", summary: `Key ghp_${"a".repeat(36)} ${"x".repeat(2000)}`,
    keyPoints: Array.from({ length: 20 }, () => `See /Users/private/root ${"x".repeat(600)}`),
    evidence: Array.from({ length: 30 }, () => ({ path: "src/query.ts", startLine: 10, endLine: 2, symbol: "x".repeat(600), metrics: "PRIVATE" })),
  } };
  const result = agentEntity(source, "query", row).entity!.understanding!;
  assert.ok(result.summary.length <= AGENT_QUERY_LIMITS.maxExplanationCharacters);
  assert.equal(result.keyPoints.length, AGENT_QUERY_LIMITS.maxKeyPoints);
  assert.ok(result.keyPoints.every(point => point.length <= AGENT_QUERY_LIMITS.maxKeyPointCharacters));
  assert.equal(result.evidence.length, AGENT_QUERY_LIMITS.maxSourceRefs);
  assert.ok(result.evidence.every(ref => ref.endLine === undefined && ref.symbol!.length <= 256));
  assert.doesNotMatch(JSON.stringify(result), /ghp_|Users|PRIVATE/);
});

test("credential redaction preserves Ask symbol names while redacting real quoted keys", () => {
  const id = "code:apps-server-src-ask-eval-live-ts:ask-eval-replay-call";
  const row = entity(id);
  row.sourceRefs = [{ path: "apps/server/src/askEvalLive.ts", commitSha: "abc123", symbol: "ask-eval-replay-call" }];
  row.responsibility = "ask-eval-replay-call records historical answers.";
  const result = agentEntity(snapshot([row]), id);
  assert.equal(result.found, true);
  assert.equal(result.entity?.id, id);
  assert.equal(result.entity?.sourceRefs[0]?.symbol, "ask-eval-replay-call");
  assert.equal(result.entity?.responsibility, row.responsibility);
  const token = `sk-${"a".repeat(32)}`;
  assert.equal(agentPublicText(`key: "${token}"`, 100), 'key: "[redacted-token]"');
  assert.equal(agentPublicText('{"password": "huntervalue", "api_key": "provider-secret-value"}', 200), '{"password": "[redacted]", "api_key": "[redacted]"}');
  assert.equal(agentPublicText("'password': 'huntervalue'", 100), "'password': '[redacted]'");
});

test("public version namespace rejects search and relation cursors when the graph revision is unchanged", () => {
  const source = snapshot([entity("a"), entity("b"), entity("c")]);
  const first = agentSearch(source, { query: "query", limit: 1, cursorNamespace: "public-version-1" });
  assert.ok(first.nextCursor);
  assert.equal(agentSearch(source, { query: "query", cursor: first.nextCursor, cursorNamespace: "public-version-2" }).error, "invalid-cursor");
  assert.equal(agentSearch(source, { query: "query", cursor: first.nextCursor, cursorNamespace: "public-version-1" }).error, undefined);
  source.relations = [{ id: "ab", from: "a", to: "b", kind: "calls", evidence: [] }, { id: "ac", from: "a", to: "c", kind: "calls", evidence: [] }];
  const relations = agentRelations(source, { entityId: "a", limit: 1, cursorNamespace: "public-version-1" });
  assert.ok(relations.nextCursor);
  assert.equal(agentRelations(source, { entityId: "a", cursor: relations.nextCursor, cursorNamespace: "public-version-2" }).error, "invalid-cursor");
});

test("maximum Unicode query and identity bounds produce a compact usable continuation cursor", () => {
  const root = "界".repeat(512);
  const query = "文".repeat(256);
  const source = snapshot([entity(root), entity("child", root)]);
  source.id = "圖".repeat(512);
  source.commitSha = "版".repeat(128);
  for (const row of source.entities) row.name = query;
  const cursorNamespace = "次".repeat(512);
  const first = agentSearch(source, { query, rootEntityId: root, cursorNamespace, limit: 1 });
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 8192, `cursor has ${first.nextCursor.length} characters`);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  const next = agentSearch(source, { query, rootEntityId: root, cursorNamespace, cursor: first.nextCursor, limit: 1 });
  assert.equal(next.error, undefined);
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]!.id, first.items[0]!.id);
  assert.equal(next.nextCursor, undefined);
  assert.equal(agentSearch(source, { query, rootEntityId: root, cursorNamespace: "other-version", cursor: first.nextCursor }).error, "invalid-cursor");
  assert.equal(agentSearch(source, { query, cursor: "a".repeat(8193) }).error, "invalid-cursor");
});


test("line selectors reach late captured windows without fabricating uncaptured source", () => {
  const source = snapshot();
  source.entities[0]!.sourceExcerpts = Array.from({ length: 12 }, (_, index) => ({ ...excerpt(), startLine: 1 + index * 100, endLine: 2 + index * 100, highlightLine: 1 + index * 100 }));
  assert.equal(agentEvidence(source, "query").excerpts.length, AGENT_QUERY_LIMITS.maxExcerpts);
  const result = agentEvidence(source, "query", { sourcePath: "src/query.ts", sourceLine: 1102 });
  assert.equal(result.status, "captured");
  assert.equal(result.excerpts.length, 1);
  assert.equal(result.excerpts[0]!.startLine, 1101);
  assert.equal(result.truncated, true);
  for (const selection of [{ sourceLine: 55 }, { sourcePath: "src/other.ts", sourceLine: 1102 }]) {
    const missing = agentEvidence(source, "query", selection);
    assert.equal(missing.status, "not-captured");
    assert.deepEqual(missing.excerpts, []);
    assert.equal(missing.scanCoverage, "unknown");
  }
  for (const selection of [{ sourceLine: 0 }, { sourceLine: NaN }, { sourceLine: 1.5 }, { sourcePath: "../secret.ts" }]) {
    assert.equal(agentEvidence(source, "query", selection).error, "invalid-query");
  }
});
