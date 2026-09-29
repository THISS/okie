import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptedAskExplanations,
  askExpansionWork,
  askQueryTokens,
  boundedEditDistance,
  buildAskIndex,
  createAskCorpusSource,
  createAskIndexCache,
  expandAskToken,
  loadAskIndex,
  MAX_ASK_FUZZY_TOKEN_CHARS,
  MAX_ASK_QUERY_TOKENS,
  FULL_EXCERPT_SECTIONS,
  MAX_ASK_SECTION_BYTES,
  MAX_LEAD_SECTION_BYTES,
  retrieveAskSections,
  sanitizeAskSlug,
  stemAskToken,
  tokenizeAskText,
  type AskCorpusLookup,
  type AskIndex,
} from "./askRetrieval.js";
import { handleAskWorkerRequest } from "./askWorker.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ref = (path: string, extra: Record<string, unknown> = {}) => ({ path, commitSha: SHA, ...extra });
const excerpt = (path: string, symbol: string, startLine: number, text: string) => ({ path, symbol, language: "typescript", startLine, endLine: startLine + text.split("\n").length - 1, highlightLine: startLine, frozenRevision: SHA, text });

/** A small Okie-shaped atlas: web renderer files live three levels below the system. */
const SNAPSHOT = {
  schemaVersion: 1,
  id: "snapshot:okie",
  repositoryId: "repo:thiss-okie",
  commitSha: SHA,
  generatedAt: "2026-09-29T00:00:00.000Z",
  entities: [
    { id: "system:okie", kind: "softwareSystem", name: "Okie", sourceRefs: [ref("README.md")] },
    { id: "container:apps-web", kind: "container", parentId: "system:okie", name: "@okie/web", responsibility: "React browser shell that renders the C4 atlas.", sourceRefs: [ref("apps/web/package.json")] },
    { id: "container:apps-server", kind: "container", parentId: "system:okie", name: "@okie/server", responsibility: "Scan server with Ask Atlas and GitHub sign-in.", sourceRefs: [ref("apps/server/package.json")] },
    { id: "component:create-renderer", kind: "component", parentId: "container:apps-web", name: "src/renderer/createRenderer.ts", sourceRefs: [ref("apps/web/src/renderer/createRenderer.ts")] },
    { id: "code:create-renderer", kind: "code", parentId: "component:create-renderer", name: "createRenderer", sourceRefs: [ref("apps/web/src/renderer/createRenderer.ts", { symbol: "createRenderer", startLine: 27, endLine: 80 })], sourceExcerpts: [excerpt("apps/web/src/renderer/createRenderer.ts", "createRenderer", 27, [
      "export async function createRenderer(host: HTMLElement, requestedBackend: string): Promise<RendererSession> {",
      "  if (requestedBackend === 'canvas2d') return createCanvasFallback(host, requestedBackend);",
      "  // Try WebGPU first, then WebGL2, then the Canvas2D fallback.",
      "  for (const backend of ['webgpu', 'webgl2']) {",
      "    try { return await WasmRendererAdapter.create(freshCanvas(host), backend); } catch { /* next */ }",
      "  }",
      "  return createCanvasFallback(host, requestedBackend, 'GPU initialization failed');",
      "}",
    ].join("\n"))] },
    { id: "component:wasm-adapter", kind: "component", parentId: "container:apps-web", name: "src/renderer/WasmRendererAdapter.ts", sourceRefs: [ref("apps/web/src/renderer/WasmRendererAdapter.ts")] },
    { id: "code:wasm-adapter", kind: "code", parentId: "component:wasm-adapter", name: "WasmRendererAdapter", sourceRefs: [ref("apps/web/src/renderer/WasmRendererAdapter.ts", { symbol: "WasmRendererAdapter", startLine: 32, endLine: 90 })], sourceExcerpts: [excerpt("apps/web/src/renderer/WasmRendererAdapter.ts", "WasmRendererAdapter", 32, "export class WasmRendererAdapter implements AtlasRenderer {\n  static async create(canvas: HTMLCanvasElement, backend: 'webgpu' | 'webgl2') {\n    await initializeWasm();\n    return new WasmRendererAdapter(createAtlasRenderer(canvas, backend));\n  }\n}")] },
    { id: "component:app", kind: "component", parentId: "container:apps-web", name: "src/App.tsx", sourceRefs: [ref("apps/web/src/App.tsx")] },
    { id: "code:app", kind: "code", parentId: "component:app", name: "App", sourceRefs: [ref("apps/web/src/App.tsx", { symbol: "App", startLine: 1, endLine: 9 })], sourceExcerpts: [excerpt("apps/web/src/App.tsx", "App", 1, "export function App() {\n  const [question, setQuestion] = useState('');\n  return <Canvas />;\n}")] },
    { id: "component:github-oauth", kind: "component", parentId: "container:apps-server", name: "src/githubOAuth.ts", sourceRefs: [ref("apps/server/src/githubOAuth.ts")] },
    { id: "code:github-authorize-url", kind: "code", parentId: "component:github-oauth", name: "githubAuthorizeUrl", sourceRefs: [ref("apps/server/src/githubOAuth.ts", { symbol: "githubAuthorizeUrl", startLine: 186, endLine: 194 })], sourceExcerpts: [excerpt("apps/server/src/githubOAuth.ts", "githubAuthorizeUrl", 186, "export function githubAuthorizeUrl(config: GithubOAuthConfig, state: string): string {\n  return `https://github.com/login/oauth/authorize?state=${state}`;\n}")] },
    { id: "component:operator-budget", kind: "component", parentId: "container:apps-server", name: "src/operatorBudget.ts", sourceRefs: [ref("apps/server/src/operatorBudget.ts")] },
    { id: "code:operator-budget-ledger", kind: "code", parentId: "component:operator-budget", name: "createOperatorBudgetLedger", sourceRefs: [ref("apps/server/src/operatorBudget.ts", { symbol: "createOperatorBudgetLedger", startLine: 40, endLine: 90 })], sourceExcerpts: [excerpt("apps/server/src/operatorBudget.ts", "createOperatorBudgetLedger", 40, "export function createOperatorBudgetLedger(limits: BudgetLimits) {\n  // Reserve before each request; refuse when the dollar cap would be exceeded.\n  return { reserve, settle };\n}")] },
  ],
  relations: [
    { id: "rel:create-uses-wasm", from: "component:create-renderer", to: "component:wasm-adapter", kind: "dependsOn", label: "imports" },
    { id: "rel:app-uses-create", from: "component:app", to: "component:create-renderer", kind: "dependsOn" },
    { id: "rel:create-renderer-uses-adapter", from: "code:create-renderer", to: "code:wasm-adapter", kind: "uses" },
  ],
};

test("tokenizer splits identifiers and paths, drops stopwords, stems lightly", () => {
  assert.deepEqual(tokenizeAskText("apps/web/src/renderer/createRenderer.ts"), ["app", "web", "rend", "creat", "rend"]);
  assert.deepEqual(tokenizeAskText("snake_case kebab-case dotted.name"), ["snak", "case", "kebab", "case", "dot", "name"]);
  assert.deepEqual(tokenizeAskText("How does the scanner pick renderers?"), ["scan", "pick", "rend"]);
  assert.equal(stemAskToken("scanning"), "scan");
  assert.equal(stemAskToken("budgets"), "budget");
  assert.equal(stemAskToken("renderer"), stemAskToken("render"));
  assert.equal(stemAskToken("rendering"), stemAskToken("renderers"));
  assert.deepEqual(tokenizeAskText("GitHub", { compounds: true }), ["git", "hub", "github"]);
  assert.equal(boundedEditDistance("oki", "okie", 1), 1);
  assert.equal(boundedEditDistance("renderr", "render", 2), 1);
  assert.ok(boundedEditDistance("budget", "widget", 1) > 1);
});

test("renderer question from the L1 system selection retrieves createRenderer.ts and WasmRendererAdapter.ts", () => {
  const index = buildAskIndex(SNAPSHOT);
  const result = retrieveAskSections(index, "How does Oki choose what renderer to use?", { selectedIds: ["system:okie", "container:apps-web", "container:apps-server"] });
  const paths = new Set(result.sections.map(section => section.path));
  assert.ok(paths.has("apps/web/src/renderer/createRenderer.ts"));
  assert.ok(paths.has("apps/web/src/renderer/WasmRendererAdapter.ts"));
  // "Oki" names the system (typo of "okie"): it must not become a search term or dominate ranking.
  assert.equal(result.matchedTerms.includes("oki"), false);
  assert.equal(result.sections[0]?.kind === "softwareSystem", false);
  // Declarations fold into their file's section: one section per file, symbols citable.
  const file = result.sections.find(section => section.id === "component:create-renderer");
  assert.match(file?.excerpt ?? "", /WebGPU first/);
  assert.deepEqual(file?.symbols?.[0], { id: "code:create-renderer", name: "createRenderer", startLine: 27, endLine: 80 });
  assert.ok((file?.excerptStartLine ?? 0) >= 27);
  assert.equal(result.sections.some(section => section.kind === "code"), false);
});

test("graph expansion lifts the files a matching declaration uses", () => {
  const index = buildAskIndex(SNAPSHOT);
  // Only createRenderer's excerpt mentions the fallback; WasmRendererAdapter.ts is reached through its dependency edge.
  const result = retrieveAskSections(index, "Canvas2D fallback after GPU initialization failed");
  const ids = result.sections.map(section => section.id);
  assert.equal(ids[0], "component:create-renderer");
  assert.ok(ids.includes("component:wasm-adapter"), ids.join(","));
  const bare = retrieveAskSections(buildAskIndex({ ...SNAPSHOT, relations: [] }), "Canvas2D fallback after GPU initialization failed");
  assert.equal(bare.sections.some(section => section.id === "component:wasm-adapter"), false);
});

test("typos match by edit distance and prefix", () => {
  const index = buildAskIndex(SNAPSHOT);
  const typo = retrieveAskSections(index, "where is the rendrer adaptr?");
  assert.equal(typo.sections.some(section => section.id === "component:wasm-adapter"), true);
  const prefix = retrieveAskSections(index, "operator budg ledger");
  assert.equal(prefix.sections[0]?.id, "component:operator-budget");
});

test("a question that only names the system returns the system and its containers", () => {
  const index = buildAskIndex(SNAPSHOT);
  const result = retrieveAskSections(index, "What is Okie?");
  assert.equal(result.systemOnly, true);
  assert.equal(result.sections[0]?.id, "system:okie");
  assert.ok(result.sections.some(section => section.kind === "container"));
});

test("nothing relevant → no sections", () => {
  const index = buildAskIndex(SNAPSHOT);
  const result = retrieveAskSections(index, "zyxwvut qqqqqq", { selectedIds: ["system:okie"] });
  assert.deepEqual(result.sections, []);
  assert.equal(result.bytes, 0);
});

test("whole-atlas search always runs; the selected scope only gets a modest boost", () => {
  const index = buildAskIndex(SNAPSHOT);
  const result = retrieveAskSections(index, "How does GitHub sign in work?", { selectedIds: ["component:create-renderer", "code:create-renderer"] });
  assert.equal(result.sections[0]?.path, "apps/server/src/githubOAuth.ts");
  assert.equal(result.sections.some(section => section.id === "code:create-renderer"), false);
});

test("byte budget and per-section cap are respected", () => {
  const big = structuredClone(SNAPSHOT) as typeof SNAPSHOT;
  for (let copy = 0; copy < 60; copy += 1) {
    big.entities.push({
      id: `code:renderer-helper-${String(copy).padStart(2, "0")}`,
      kind: "code",
      parentId: `component:renderer-helper-${copy % 20}`,
      name: `rendererHelper${copy}`,
      sourceRefs: [ref(`apps/web/src/renderer/helper${copy % 20}.ts`, { symbol: `rendererHelper${copy}`, startLine: 1, endLine: 200 })],
      sourceExcerpts: [excerpt(`apps/web/src/renderer/helper${copy % 20}.ts`, `rendererHelper${copy}`, 1, Array.from({ length: 48 }, (_, line) => `const renderer${line} = render(${"x".repeat(120)});`).join("\n"))],
    } as never);
  }
  for (let file = 0; file < 20; file += 1) big.entities.push({ id: `component:renderer-helper-${file}`, kind: "component", parentId: "container:apps-web", name: `src/renderer/helper${file}.ts`, sourceRefs: [ref(`apps/web/src/renderer/helper${file}.ts`)] } as never);
  const index = buildAskIndex(big);
  for (const byteBudget of [3_000, 8_000, 24_000]) {
    const result = retrieveAskSections(index, "renderer", { byteBudget });
    assert.ok(result.bytes <= byteBudget, `${result.bytes} > ${byteBudget}`);
    assert.equal(result.bytes, result.sections.reduce((sum, section) => sum + Buffer.byteLength(JSON.stringify(section)), 0));
    result.sections.forEach((section, rank) => assert.ok(Buffer.byteLength(JSON.stringify(section)) <= (rank < FULL_EXCERPT_SECTIONS ? MAX_LEAD_SECTION_BYTES : MAX_ASK_SECTION_BYTES)));
    assert.ok(result.sections.length > 0);
  }
  // Many small declaration hits fold into their files: one section per file, never a code section.
  const wide = retrieveAskSections(index, "renderer helper", { byteBudget: 200_000 }).sections;
  assert.equal(new Set(wide.map(section => section.id)).size, wide.length);
  assert.equal(wide.some(section => section.kind === "code"), false);
  assert.ok(wide.filter(section => section.id.startsWith("component:renderer-helper-")).length === 20);
});

test("retrieval is deterministic, including under reordered input", () => {
  const question = "How does the renderer fall back from WebGPU to Canvas2D?";
  const first = retrieveAskSections(buildAskIndex(SNAPSHOT), question, { selectedIds: ["system:okie"] });
  const again = retrieveAskSections(buildAskIndex(SNAPSHOT), question, { selectedIds: ["system:okie"] });
  const reversed = retrieveAskSections(buildAskIndex({ ...SNAPSHOT, entities: [...SNAPSHOT.entities].reverse(), relations: [...SNAPSHOT.relations].reverse() }), question, { selectedIds: ["system:okie"] });
  assert.deepEqual(again, first);
  assert.deepEqual(reversed, first);
  assert.ok(first.sections.length > 0);
});

test("only accepted explanations are indexed; v3 key points are searchable", () => {
  const sidecar = {
    scopes: [
      { scopeId: "container:apps-web", state: "accepted" },
      { scopeId: "container:apps-server", state: "failed" },
    ],
    explanations: [
      { scopeId: "container:apps-web", content: { format: "v3", summary: "The **web** shell draws the atlas.", keyPoints: ["Backend negotiation lives in `createRenderer`.", ""] } },
      { scopeId: "container:apps-server", content: { format: "v3", summary: "Zanzibar quokka server", keyPoints: [] } },
      { scopeId: "component:app", explanation: { summary: "Legacy explanation for the shell.", diagram: { nodes: [] } } },
    ],
  };
  const accepted = acceptedAskExplanations(sidecar);
  assert.deepEqual([...accepted.keys()].sort(), ["component:app", "container:apps-web"]);
  assert.deepEqual(accepted.get("container:apps-web")?.keyPoints, ["Backend negotiation lives in `createRenderer`."]);
  const index = buildAskIndex(SNAPSHOT, sidecar);
  const hit = retrieveAskSections(index, "backend negotiation");
  assert.equal(hit.sections[0]?.id, "container:apps-web", hit.sections.map(section => section.id).join(","));
  assert.equal(hit.sections[0]?.summary, "The **web** shell draws the atlas.");
  assert.deepEqual(hit.sections[0]?.keyPoints, ["Backend negotiation lives in `createRenderer`."]);
  assert.deepEqual(retrieveAskSections(index, "zanzibar quokka").sections, []);
});

test("slug sanitisation allows route slugs and scanRepo ids only", () => {
  assert.equal(sanitizeAskSlug("thiss__okie"), "thiss__okie");
  assert.equal(sanitizeAskSlug(""), "");
  assert.equal(sanitizeAskSlug("acme.widgets-2"), "acme.widgets-2");
  assert.equal(sanitizeAskSlug("../etc"), undefined);
  assert.equal(sanitizeAskSlug("a/b"), undefined);
  assert.equal(sanitizeAskSlug(".hidden"), undefined);
  assert.equal(sanitizeAskSlug("x".repeat(201)), undefined);
  assert.equal(sanitizeAskSlug(42), undefined);
});

test("corpus source locates the scan-root and per-slug snapshots (stat only); the worker verifies commitSha and caches", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-ask-corpus-"));
  try {
    writeFileSync(join(root, "snapshot.json"), JSON.stringify(SNAPSHOT));
    mkdirSync(join(root, "acme__widgets"));
    writeFileSync(join(root, "acme__widgets", "snapshot.json"), JSON.stringify({ ...SNAPSHOT, commitSha: "feedfacefeedface" }));
    const source = createAskCorpusSource({ scanRoot: root });
    const cache = createAskIndexCache();
    let id = 0;
    const resolve = (input: AskCorpusLookup) => { const candidates = source.locate(input); return handleAskWorkerRequest(cache, { id: id += 1, commitSha: input.commitSha, candidates, buildKeys: candidates.map(candidate => candidate.key), question: "renderer", selectedIds: [], byteBudget: 24_000 }).evidence; };
    assert.equal(resolve({ slug: "", owner: "THISS", repo: "okie", commitSha: SHA })?.entityCount, SNAPSHOT.entities.length);
    // The dogfood slug aliases onto the scan-root trio like `/scan/thiss__okie/*`.
    assert.equal(resolve({ slug: "thiss__okie", owner: "THISS", repo: "okie", commitSha: SHA.slice(0, 12) })?.source, "scan");
    // No slug: owner__repo, then the scan root.
    assert.deepEqual(source.locate({ owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" }).map(location => location.snapshotPath), [join(root, "acme__widgets", "snapshot.json")]);
    assert.ok(resolve({ owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" }));
    assert.equal(resolve({ slug: "", owner: "THISS", repo: "okie", commitSha: "0000000000" }), undefined);
    assert.deepEqual(source.locate({ slug: "missing", owner: "THISS", repo: "okie", commitSha: SHA }), []);
    // A slug must belong to the atlas identity: no borrowing another repo's corpus or the scan root.
    assert.deepEqual(source.locate({ slug: "acme__widgets", owner: "THISS", repo: "okie", commitSha: "feedfacefeedface" }), []);
    assert.deepEqual(source.locate({ slug: "", owner: "acme", repo: "widgets", commitSha: SHA }), []);
    assert.ok(resolve({ slug: "ACME__Widgets", owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" }));
    assert.equal(cache.stats().indexBuilds, 2);

    // A corrupt snapshot never throws: the worker reports the key failed (no corpus: Ask answers scope-only).
    writeFileSync(join(root, "acme__widgets", "snapshot.json"), "{ not json");
    const candidates = source.locate({ slug: "acme__widgets", owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" });
    const reply = handleAskWorkerRequest(cache, { id: 99, commitSha: "feedfacefeedface", candidates, buildKeys: [candidates[0]!.key], question: "renderer", selectedIds: [], byteBudget: 24_000 });
    assert.deepEqual([reply.ok, reply.evidence, reply.failedKeys], [true, undefined, [candidates[0]!.key]]);
    // Oversized snapshots are never located, so never read.
    assert.deepEqual(createAskCorpusSource({ scanRoot: root, maxSnapshotBytes: 64 }).locate({ slug: "", owner: "THISS", repo: "okie", commitSha: SHA }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLA-304: a publication snapshot is stat'ed before it is read; oversized ones are never read and never fall back to legacy bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-ask-publication-"));
  try {
    writeFileSync(join(root, "snapshot.json"), JSON.stringify(SNAPSHOT));
    mkdirSync(join(root, "thiss__okie"));
    writeFileSync(join(root, "thiss__okie", "snapshot.json"), JSON.stringify(SNAPSHOT));
    const artifact = join(root, "artifact");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "snapshot.json"), JSON.stringify(SNAPSHOT));
    writeFileSync(join(artifact, "operator-explanations.json"), JSON.stringify({ explanations: [] }));
    const store = {
      artifactFilePath: (_revision: string, file: string) => join(artifact, file),
      readArtifactFile: () => { throw new Error("the locator must never read an artifact"); },
    };
    let stateReads = 0;
    const publications = { currentWithArtifactForSlug: () => { stateReads += 1; return { publication: { artifactRevisionId: "artifact-1", versionId: "v1" }, artifact: { artifactRevisionId: "artifact-1", sourceCommitSha: SHA } }; } };
    const locate = (limits: { maxSnapshotBytes?: number; maxSidecarBytes?: number } = {}, commitSha = SHA) => createAskCorpusSource({ scanRoot: root, publications: publications as never, store: store as never, ...limits }).locate({ slug: "thiss__okie", owner: "THISS", repo: "okie", commitSha });
    assert.deepEqual(locate(), [{ key: "artifact:artifact-1", source: "publication", snapshotPath: join(artifact, "snapshot.json"), sidecarPath: join(artifact, "operator-explanations.json"), size: statSync(join(artifact, "snapshot.json")).size }]);
    assert.equal(stateReads, 1, "one operator-state read per located slug");
    assert.deepEqual(locate({ maxSnapshotBytes: 64 }), [], "oversized publication: no corpus, and no legacy fallback");
    // A request for another commit is refused from the artifact's recorded commit: never located, so never built.
    assert.deepEqual(locate({}, "feedfacefeedface"), []);
    assert.equal(locate({}, SHA.slice(0, 10)).length, 1, "a 7+ char prefix still matches");
    assert.equal(locate({ maxSidecarBytes: 4 })[0]?.sidecarPath, undefined, "an oversized sidecar is skipped");
    // The worker re-checks the cap on the open file (it may have grown since it was located).
    assert.throws(() => loadAskIndex({ snapshotPath: join(artifact, "snapshot.json") }, { maxSnapshotBytes: 64 }), /size cap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("system-name folding only swallows the WHOLE name (fuzzy for 3+ chars), never generic parts", () => {
  const named = (name: string, repositoryId: string) => ({
    ...SNAPSHOT,
    repositoryId,
    entities: [
      { id: "system:x", kind: "softwareSystem", name, sourceRefs: [ref("README.md")] },
      { id: "component:core-code", kind: "component", parentId: "system:x", name: "src/core/code.ts", sourceRefs: [ref("src/core/code.ts")] },
      { id: "component:api", kind: "component", parentId: "system:x", name: "src/api.ts", sourceRefs: [ref("src/api.ts")] },
    ],
    relations: [],
  });
  const core = retrieveAskSections(buildAskIndex(named("acme-core", "repo:acme-core")), "Where is the core code?");
  assert.deepEqual(core.matchedTerms, ["code", "core"]);
  assert.equal(core.sections[0]?.id, "component:core-code");
  const app = retrieveAskSections(buildAskIndex(named("acme-app", "repo:acme-app")), "Where is the api?");
  assert.deepEqual(app.matchedTerms, ["api"]);
  assert.equal(app.sections[0]?.id, "component:api");
  // The whole name (and a one-edit typo of it) still names the system.
  const okie = buildAskIndex(SNAPSHOT);
  assert.equal(retrieveAskSections(okie, "What is Okie?").systemOnly, true);
  assert.equal(retrieveAskSections(okie, "What is Oki?").systemOnly, true);
  // Short repo names fold only exact or truncated spellings, and never a word the index already has.
  const shortNamed = (name: string) => buildAskIndex({
    ...SNAPSHOT,
    repositoryId: `repo:${name}`,
    entities: [
      { id: "system:x", kind: "softwareSystem", name, sourceRefs: [ref("README.md")] },
      { id: "component:code", kind: "component", parentId: "system:x", name: "src/code.ts", sourceRefs: [ref("src/code.ts")] },
      { id: "component:span", kind: "component", parentId: "system:x", name: "src/span.ts", sourceRefs: [ref("src/span.ts")] },
    ],
    relations: [],
  } as never);
  const coreCode = retrieveAskSections(shortNamed("core"), "Where is the code?");
  assert.deepEqual(coreCode.matchedTerms, ["code"]);
  assert.equal(coreCode.systemOnly, false);
  const scanSpan = retrieveAskSections(shortNamed("scan"), "how is a span scanned");
  assert.equal(scanSpan.systemOnly, false);
  assert.ok(scanSpan.matchedTerms.includes("span"));
  assert.equal(scanSpan.sections[0]?.id, "component:span");
  // "spam" is not indexed but a four-letter name folds only its truncation, never a one-letter swap.
  assert.equal(retrieveAskSections(shortNamed("scan"), "what is spam?").systemOnly, false);
  assert.equal(retrieveAskSections(shortNamed("scan"), "what is sca?").systemOnly, true);
  // The GitHub repo name can be supplied as another whole name.
  assert.equal(retrieveAskSections(buildAskIndex(named("Widget Service", "repo:acme-widgets")), "what are widgets?", { systemNames: ["widgets"] }).systemOnly, true);
});

test("stale explanations are not indexed", () => {
  const content = { format: "v3", summary: "Zanzibar quokka flow.", keyPoints: [] };
  for (const sidecar of [
    { staleScopes: ["container:apps-web"], explanations: [{ scopeId: "container:apps-web", content }] },
    { scopes: [{ scopeId: "container:apps-web", state: "accepted", stale: true }], explanations: [{ scopeId: "container:apps-web", content }] },
    { explanations: [{ scopeId: "container:apps-web", stale: true, content }] },
  ]) {
    assert.equal(acceptedAskExplanations(sidecar).size, 0);
    assert.deepEqual(retrieveAskSections(buildAskIndex(SNAPSHOT, sidecar), "zanzibar quokka").sections, []);
  }
});

test("a section never exceeds the per-section cap, even without an excerpt", () => {
  const huge = structuredClone(SNAPSHOT) as typeof SNAPSHOT;
  huge.entities.push({ id: "component:huge", kind: "component", parentId: "container:apps-web", name: `quokka ${"n".repeat(400)}`, responsibility: `quokka ${"r".repeat(5_000)}`, sourceRefs: [ref(`src/${"p".repeat(500)}.ts`)] } as never);
  const sidecar = { explanations: [{ scopeId: "component:huge", content: { format: "v3", summary: `quokka ${"s".repeat(5_000)}`, keyPoints: Array.from({ length: 8 }, () => "k".repeat(400)) } }] };
  const [section] = retrieveAskSections(buildAskIndex(huge, sidecar), "quokka").sections;
  assert.equal(section?.id, "component:huge");
  assert.ok(Buffer.byteLength(JSON.stringify(section)) <= MAX_LEAD_SECTION_BYTES);
});

// ---------------------------------------------------------------------------
// CLA-304: index-backed token expansion (exact equivalence with the old O(vocab) scan) and hostile-query bounds.

/** The pre-CLA-304 expandToken, verbatim except that it reads a locally bucketed vocabulary. */
const REFERENCE_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map(([
  ["sign", ["auth", "oauth", "login", "session"]], ["signin", ["auth", "oauth", "login", "session"]], ["login", ["auth", "oauth", "session", "signin"]],
  ["auth", ["oauth", "login", "session"]], ["authenticate", ["auth", "oauth", "login"]], ["authorize", ["auth", "access", "permission"]], ["permission", ["access", "authorize"]],
  ["choose", ["select", "pick"]], ["pick", ["select", "choose"]], ["select", ["choose", "pick"]],
  ["spend", ["cost", "budget"]], ["cost", ["spend", "budget"]], ["money", ["cost", "budget", "spend"]],
  ["repo", ["repository"]], ["repository", ["repo"]],
] as const).map(([word, synonyms]) => [stemAskToken(word), synonyms.map(stemAskToken)] as const));
function referenceExpandToken(postings: ReadonlyMap<string, unknown>, token: string): Array<{ term: string; weight: number }> {
  const vocabByLength = new Map<number, string[]>();
  for (const term of [...postings.keys()].sort()) { const list = vocabByLength.get(term.length); if (list) list.push(term); else vocabByLength.set(term.length, [term]); }
  const synonyms = (REFERENCE_SYNONYMS.get(token) ?? []).filter(term => term !== token && postings.has(term)).map(term => ({ term, weight: 0.5 }));
  if (postings.has(token)) return [{ term: token, weight: 1 }, ...synonyms];
  const limit = token.length >= 7 ? 2 : token.length >= 3 ? 1 : 0;
  if (limit === 0) return synonyms;
  // CLA-304's only intended change: tokens longer than MAX_ASK_FUZZY_TOKEN_CHARS match exactly only.
  if (token.length > MAX_ASK_FUZZY_TOKEN_CHARS) return synonyms;
  const out: Array<{ term: string; weight: number }> = [];
  for (let length = token.length - limit; length <= token.length + limit; length += 1) {
    for (const term of vocabByLength.get(length) ?? []) {
      if (boundedEditDistance(token, term, limit) <= limit) out.push({ term, weight: 0.6 });
    }
  }
  if (token.length >= 4) {
    for (const [length, terms] of vocabByLength) {
      if (length <= token.length + limit) continue;
      for (const term of terms) if (term.startsWith(token)) out.push({ term, weight: 0.7 });
    }
  }
  const best = new Map<string, number>();
  for (const { term, weight } of out) best.set(term, Math.max(best.get(term) ?? 0, weight));
  for (const { term, weight } of synonyms) best.set(term, Math.max(best.get(term) ?? 0, weight));
  return [...best].map(([term, weight]) => ({ term, weight })).sort((left, right) => left.term.localeCompare(right.term)).slice(0, 24);
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
const vocabIndex = (terms: Iterable<string>): AskIndex => {
  const postings = new Map([...terms].map(term => [term, [[0, 1]] as Array<[number, number]>]));
  return { postings, vocab: [...postings.keys()].sort() } as unknown as AskIndex;
};

test("CLA-304: index-backed expansion equals the brute-force scan on random vocabularies and tokens", () => {
  const random = prng(304);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const word = (alphabet: string, min: number, max: number) => Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => pick([...alphabet])).join("");
  const typo = (source: string, alphabet: string) => {
    const at = Math.floor(random() * (source.length + 1));
    switch (Math.floor(random() * 4)) {
      case 0: return source.slice(0, at) + pick([...alphabet]) + source.slice(at);
      case 1: return source.slice(0, at) + source.slice(at + 1);
      case 2: return source.slice(0, at) + pick([...alphabet]) + source.slice(at + 1);
      default: return at + 1 < source.length ? source.slice(0, at) + source[at + 1] + source[at] + source.slice(at + 2) : source;
    }
  };
  let compared = 0; let nonTrivial = 0; let truncated = 0;
  for (let round = 0; round < 80; round += 1) {
    // Small alphabets make dense tries (many near neighbours); the full one is realistic.
    const alphabet = pick(["ab", "abc", "abcde", "abcdefghijklmnopqrstuvwxyz0123456789", "aeiorstn"]);
    const size = pick([1, 5, 40, 300, 2_000]);
    const terms = new Set<string>();
    while (terms.size < size) {
      const roll = random();
      if (roll < 0.05) terms.add(stemAskToken(pick(["sign", "auth", "oauth", "login", "session", "select", "cost", "budget", "repo", "repository", "access"])));
      else if (roll < 0.35 && terms.size) terms.add(typo(pick([...terms]), alphabet) || "zz");
      else if (roll < 0.5 && terms.size) terms.add(pick([...terms]) + word(alphabet, 1, 6));
      else terms.add(word(alphabet, 2, roll < 0.52 ? 45 : 14));
    }
    for (const term of [...terms]) if (term.length < 2) terms.delete(term);
    const index = vocabIndex(terms);
    const known = [...terms];
    for (let draw = 0; draw < 60; draw += 1) {
      const roll = random();
      const token = roll < 0.25 ? typo(typo(pick(known), alphabet), alphabet)
        : roll < 0.45 ? typo(pick(known), alphabet)
        : roll < 0.6 ? pick(known).slice(0, 2 + Math.floor(random() * 10))
        : roll < 0.65 ? pick(known)
        : roll < 0.7 ? stemAskToken(pick(["sign", "login", "auth", "choose", "spend", "money", "repo", "signin", "authorize"]))
        : roll < 0.75 ? word(alphabet, 38, 50)
        : word(alphabet, 2, 12);
      if (token.length < 2) continue;
      const expected = referenceExpandToken(index.postings, token);
      assert.deepEqual(expandAskToken(index, token), expected, `vocab ${terms.size} (${alphabet}), token ${token}`);
      assert.deepEqual(expandAskToken(index, token), expected, "memoised answer is identical");
      compared += 1;
      if (expected.length > 1) nonTrivial += 1;
      if (expected.length === 24) truncated += 1;
    }
  }
  assert.ok(compared > 4_000 && nonTrivial > 500 && truncated > 50, `${compared} compared, ${nonTrivial} with several expansions, ${truncated} cut to 24`);
});

test("CLA-304: a hostile question is capped to MAX_ASK_QUERY_TOKENS tokens and stays cheap on a large index", () => {
  const random = prng(7);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const word = (length: number) => Array.from({ length }, () => letters[Math.floor(random() * 26)]).join("");
  // ~25k distinct terms: 5,000 files with five random identifier words each.
  const entities: Array<Record<string, unknown>> = [{ id: "system:x", kind: "softwareSystem", name: "Hostile", sourceRefs: [] }];
  for (let file = 0; file < 5_000; file += 1) {
    const words = Array.from({ length: 5 }, () => word(5 + Math.floor(random() * 8)));
    entities.push({ id: `component:f${file}`, kind: "component", parentId: "system:x", name: `src/${words.join("_")}.ts`, sourceRefs: [ref(`src/${words.join("_")}.ts`)] });
  }
  const index = buildAskIndex({ commitSha: SHA, entities, relations: [] });
  assert.ok(index.vocab.length > 20_000, `${index.vocab.length} terms`);
  // ≈2,000 chars: 300+ distinct out-of-vocabulary tokens, 60-char tokens, and repeats.
  const hostile = [
    ...Array.from({ length: 320 }, () => `q${word(4)}`),
    ...Array.from({ length: 6 }, () => word(60)),
    ...Array.from({ length: 20 }, () => "qqqq"),
  ].join(" ").slice(0, 2_000);
  const tokens = askQueryTokens(index, hostile);
  assert.ok(tokens.length > 250, `${tokens.length} distinct tokens`);
  const workBefore = askExpansionWork();
  const started = performance.now();
  const result = retrieveAskSections(index, hostile);
  const elapsed = performance.now() - started;
  const work = askExpansionWork() - workBefore;
  // The old scan touched every term of the vocabulary for EACH token (32 × 25k = 800k terms here); the
  // index-backed walk must stay below ONE such scan for the whole question (measured: ~6.6k).
  assert.ok(work > 0 && work < index.vocab.length, `${work} vocabulary steps for ${index.vocab.length} terms`);
  assert.ok(result.matchedTerms.length <= MAX_ASK_QUERY_TOKENS);
  assert.ok(result.matchedTerms.every(term => tokens.slice(0, MAX_ASK_QUERY_TOKENS).includes(term)), "only the first tokens in question order are searched");
  assert.ok(elapsed < 1_500, `hostile retrieval took ${Math.round(elapsed)} ms (secondary, generous wall-clock check)`);
  // A long token is exact-only: a one-letter typo of a 41+ char term does not expand.
  const long = "a".repeat(MAX_ASK_FUZZY_TOKEN_CHARS + 1);
  const withLong = vocabIndex([long, `${long}b`]);
  assert.deepEqual(expandAskToken(withLong, long), [{ term: long, weight: 1 }]);
  assert.deepEqual(expandAskToken(withLong, `${long.slice(1)}c`), []);
});

test("CLA-304: the worker handler builds only authorised keys, and the index cache never holds more than maxIndexes", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-ask-build-keys-"));
  try {
    const paths = ["a", "b", "c"].map(name => { const path = join(root, `${name}.json`); writeFileSync(path, JSON.stringify(SNAPSHOT)); return { key: name, source: "scan" as const, snapshotPath: path }; });
    const cache = createAskIndexCache({ maxIndexes: 2 });
    const building: string[] = [];
    const ask = (candidate: typeof paths[number], buildKeys: string[]) => handleAskWorkerRequest(cache, { id: 1, commitSha: SHA, candidates: [candidate], buildKeys, question: "renderer", selectedIds: [], byteBudget: 24_000 }, { onBuilding: key => { building.push(key); assert.ok(cache.keys().length < 2, "evicted before the build"); } });
    assert.deepEqual([ask(paths[0]!, []).ok, ask(paths[0]!, []).error], [false, "Ask index not warm"]);
    assert.equal(cache.stats().indexBuilds, 0, "an unauthorised miss never builds");
    for (const candidate of paths) assert.ok(ask(candidate, [candidate.key]).evidence);
    assert.deepEqual(building, ["a", "b", "c"]);
    assert.deepEqual(cache.keys(), ["b", "c"]);
    assert.ok(ask(paths[2]!, []).evidence, "a warm key needs no authorisation");
    // An unauthorised first candidate is skipped, not fatal: a warm second candidate (the dogfood slot) still answers.
    const skip = handleAskWorkerRequest(cache, { id: 2, commitSha: SHA, candidates: [paths[0]!, paths[2]!], buildKeys: [], question: "renderer", selectedIds: [], byteBudget: 24_000 });
    assert.equal(skip.ok, true);
    assert.ok(skip.evidence, "the warm second candidate was searched");
    assert.ok(!cache.keys().includes("a"), "the skipped key was not built");
    // A joined key is built when still missing, unless its build already failed in this worker.
    const failedBuilds = new Set<string>();
    let attempts = 0;
    const broken = join(root, "broken.json");
    writeFileSync(broken, "{not json");
    const join1 = (candidate: { key: string; source: "scan"; snapshotPath: string }) => handleAskWorkerRequest(cache, { id: 3, commitSha: SHA, candidates: [candidate], buildKeys: [], joinKeys: [candidate.key], question: "renderer", selectedIds: [], byteBudget: 24_000 }, { failedBuilds, onBuilding: () => { attempts += 1; } });
    assert.ok(join1(paths[0]!).evidence, "a joiner builds the key when the builder never ran");
    assert.equal(attempts, 1);
    assert.deepEqual(join1({ key: "broken", source: "scan", snapshotPath: broken }).failedKeys, ["broken"]);
    assert.deepEqual(join1({ key: "broken", source: "scan", snapshotPath: broken }).error, "Ask index not warm", "a failed joined key is not rebuilt");
    assert.equal(attempts, 2, "one build attempt for the broken key, not two");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
