import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptedAskExplanations,
  boundedEditDistance,
  buildAskIndex,
  createAskCorpusSource,
  FULL_EXCERPT_SECTIONS,
  MAX_ASK_SECTION_BYTES,
  MAX_LEAD_SECTION_BYTES,
  retrieveAskSections,
  sanitizeAskSlug,
  stemAskToken,
  tokenizeAskText,
} from "./askRetrieval.js";

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

test("corpus source resolves the scan-root and per-slug snapshots, verifies commitSha, and caches", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-ask-corpus-"));
  try {
    writeFileSync(join(root, "snapshot.json"), JSON.stringify(SNAPSHOT));
    mkdirSync(join(root, "acme__widgets"));
    writeFileSync(join(root, "acme__widgets", "snapshot.json"), JSON.stringify({ ...SNAPSHOT, commitSha: "feedfacefeedface" }));
    const source = createAskCorpusSource({ scanRoot: root });
    assert.equal(source.resolve({ slug: "", owner: "THISS", repo: "okie", commitSha: SHA })?.index.commitSha, SHA);
    // The dogfood slug aliases onto the scan-root trio like `/scan/thiss__okie/*`.
    assert.equal(source.resolve({ slug: "thiss__okie", owner: "THISS", repo: "okie", commitSha: SHA.slice(0, 12) })?.source, "scan");
    // No slug: owner__repo, then the scan root.
    assert.equal(source.resolve({ owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" })?.index.commitSha, "feedfacefeedface");
    assert.equal(source.resolve({ slug: "", owner: "THISS", repo: "okie", commitSha: "0000000000" }), undefined);
    assert.equal(source.resolve({ slug: "missing", owner: "THISS", repo: "okie", commitSha: SHA }), undefined);
    // A slug must belong to the atlas identity: no borrowing another repo's corpus or the scan root.
    assert.equal(source.resolve({ slug: "acme__widgets", owner: "THISS", repo: "okie", commitSha: "feedfacefeedface" }), undefined);
    assert.equal(source.resolve({ slug: "", owner: "acme", repo: "widgets", commitSha: SHA }), undefined);
    assert.equal(source.resolve({ slug: "ACME__Widgets", owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" })?.index.commitSha, "feedfacefeedface");
    assert.equal(source.stats().indexBuilds, 2);

    // Corrupt or oversized snapshots never throw: no corpus (Ask then answers scope-only).
    writeFileSync(join(root, "acme__widgets", "snapshot.json"), "{ not json");
    assert.equal(source.resolve({ slug: "acme__widgets", owner: "acme", repo: "widgets", commitSha: "feedfacefeedface" }), undefined);
    const tiny = createAskCorpusSource({ scanRoot: root, maxSnapshotBytes: 64 });
    assert.equal(tiny.resolve({ slug: "", owner: "THISS", repo: "okie", commitSha: SHA }), undefined);
    assert.equal(tiny.stats().indexBuilds, 0);
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
