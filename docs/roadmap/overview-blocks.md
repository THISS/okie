# Overview blocks (`blocks/v1`)

Status: pilot shipped for containers and software systems (CLA-149). Other kinds keep the classic Overview.

The inspector Overview is an **ordered array of typed blocks**, like a Notion page: array order is display order. Each block type maps to one hard-coded React renderer. No model chooses components. Deterministic blocks come from scan facts; enrichment blocks come from the accepted explanation. Each block records its provenance, and validation drops individual blocks rather than the whole Overview.

Code: `apps/web/src/blocks/` — `blockModel.ts` (catalog, caps, `validateBlocks`), `composeBlocks.ts` (composer + legacy adapter), `blockPlanner.ts` (planner seam + default recipes), `OverviewBlocks.tsx` (renderer registry). The switch lives in `inspector/ContextualOverviewView.tsx` (`usesBlockOverview(kind)`), so the dogfood-pinned `App.tsx` did not change.

## Schema

```ts
type OverviewBlock = { id: string; provenance: 'observed' | 'enrichment' } & (
  | { type: 'markdown'; text }                          // markdown-lite (enrichment) or literal (observed)
  | { type: 'keyPoints'; title; items: string[] }
  | { type: 'nodeRefs'; title; refs: { id; reason }[] }  // chips → onOpenEntity(id)
  | { type: 'relations'; direction: 'parent' | 'dependencies' | 'dependents'; items: { id; relationship }[] }
  | { type: 'children'; items: { id; relationship }[] }
  | { type: 'mermaid'; title; source }
  | { type: 'table'; title; caption?; columns; rows }
  | { type: 'evidence'; items: { entityId?; path?; startLine?; endLine? }[] })
```

- Ids are stable, deterministic strings: `summary`, `nodeRefs:related`, `relations:parent|dependencies|dependents`, `children`, `enrichment:summary|keyPoints|diagram|table|evidence`.
- Provenance is **assigned by the composer per source**. Any `provenance` field in the input is ignored.
- Ids are namespaced by source. Enrichment ids must start with `enrichment:`, and observed ids must not. A model-authored block cannot take an observed block's id or place.
- There is no `metrics` or `callout` block yet. Counts already appear on each list heading, and `keyPoints` covers the callout case. Add either type only when it carries a fact the Overview doesn't already show.

## Renderer registry

`BLOCK_RENDERERS: { [T in BlockType]: Renderer<T> }` is a fixed object with one entry per type, checked by a test. Lookup uses `Object.hasOwn`, and a block whose type is not a registry key renders nothing, not even its wrapper. Renderers reuse the existing components:

| type | renderer |
|---|---|
| markdown | `BlockMarkdown` (enrichment) / `<p class="overview-description">` (observed, literal) |
| keyPoints | CLA-260 "Worth a look" list with `InlineMarkdown` |
| nodeRefs | chip buttons. The label comes from `entityName(id)` and the reason from the block. |
| relations / children | `LinkList` (moved to `inspector/LinkList.tsx`); the parent row uses `kindLabel` |
| mermaid | `MermaidDiagram` (strict security level, two DOMPurify passes) |
| table | `ExplanationTable` (inline grid + expand dialog) |
| evidence | `EvidenceRow` (source button → `onOpenEvidence`) |

QA hooks: the root has `data-overview-blocks="v1"` and `data-blocks-dropped="<n>"`. Each block has `data-block-id`, `data-block-type` and `data-block-provenance`.

## Provenance rules

- **Observed** blocks are graph and containment facts plus the captured responsibility (`inspectorAcceptedSummary`). Only observed blocks may use `relations` and `children` (`OBSERVED_ONLY_TYPES`). Enrichment input that uses these types is dropped.
- **Enrichment** blocks are model prose. They are shown as prose, never as graph facts.
- Labels and ranges resolve from canonical ids. `nodeRefs`, `relations` and `children` keep only `{id, reason|relationship}`, and the visible name always comes from the snapshot lookup (host `entityName`, then names the overview resolved). Any label in the input is discarded. An unresolvable id rejects the block.
- Citations must resolve. An evidence item is kept only if it has a safe relative path (`validRelativeSourcePath`) or an `entityId` the atlas knows. Line numbers must be positive integers, with `endLine ≥ startLine`.
- A name counts only when the lookup returns a non-empty string (`resolvedName`). Prototype keys such as `__proto__` and empty names are unknown. The composer checks names the overview already resolved before the host lookup.
- An evidence item with an unsafe path but a known `entityId` is kept as an entity-only citation (the path and lines are removed). An item with neither a known entity nor a safe path is omitted.
- An accepted explanation summary replaces the captured summary. If there is none, the captured summary shows. The "No description has been captured yet." placeholder shows only when there is no captured summary and the accepted explanation has no content (summary, key points or evidence). It never depends on which blocks survived validation.

## Validation: drop vs trim

`validateBlocks(raw, { source, entityName }) → { blocks, dropped, trimmed }`. Each block is rebuilt from a whitelist of props, so `href`, `onClick`, `html`, `url`, `action` and `import` never reach a renderer.

**Whole-block drop** (`dropped: { id?, type?, reason }[]`) is only for problems that make a block structurally invalid:

- a non-object entry, or a malformed, duplicate or out-of-namespace id
- an unknown type, or an observed-only type from enrichment
- nesting deeper than the cap, or a position past the block cap
- a wrong shape: a list that isn't a list, a missing required text/title, a bad `direction`, a parent that isn't exactly one item, or a non-text table cell
- a mermaid source over its char or line cap, or a table over its column cap
- no valid item left (e.g. every evidence item or ref was rejected)

**Trim** (`trimmed: { id, type, omitted, reasons }[]`, block kept) covers cap overruns and bad items, so observed facts degrade instead of vanishing:

- Lists over their cap are sliced to the first N, and the overflow is counted. This applies to key points, node refs, relations/children items, table rows and evidence items.
- Individually invalid items are omitted and counted. These are an unknown or repeated entity ref, a key point that isn't text, and a citation with neither a known entity nor a safe path.
- Text over its cap is clipped with `…` and not counted, because the ellipsis shows it. This applies to markdown (including a captured summary), titles, key points, ref reasons, relationship labels, table cells and captions.
- A missing relationship label on an observed link falls back to the neutral label `related`.

The atlas shows one quiet note: "1 section omitted.", "3 items omitted." or "1 section and 3 items omitted.". It never shows the reasons, which stay in the result for tests and a future operator audit view. The root carries `data-blocks-dropped` and `data-block-items-omitted`.

## Caps (`BLOCK_CAPS`)

The limits are set with headroom over the server's v3 limits (`OPERATOR_EXPLANATION_LIMITS`), because legacy content predates them.

| cap | value | over cap |
|---|---|---|
| blocks per Overview / raw entries read per source | 16 / 64 | drop extra blocks / skip unread entries (both noted) |
| id chars | 64 | drop (malformed id) |
| nesting depth per block | 5 (a table is 3) | drop |
| title chars | 120 | clip |
| markdown chars | 4000 (= `MARKDOWN_LITE_MAX_LENGTH`) | clip |
| keyPoints items × chars | 8 × 400 | slice × clip |
| nodeRefs refs × reason chars | 8 × 80 (the composer emits ≤ 6) | slice × clip |
| relations/children items × relationship chars | 1000 × 80 | slice × clip |
| mermaid chars / lines | 4000 / 60 | **drop** (a diagram can't be cut safely) |
| table cols | 6 | **drop** |
| table rows × cell chars; caption | 20 × 400; 200 | slice × clip; clip |
| evidence items | 24 | slice |

## Composer, legacy adapters and default recipes

`composeOverviewBlocks({ overview, explanation, entityName, planner })`:

1. **Observed candidates** come from `ContextualOverview`: the summary, `nodeRefs:related` (the 6 most-connected direct neighbours, with reasons such as `depends on · calls, streams; used by · notifies`), parent, dependencies, dependents and children.
2. **Enrichment candidates** come from the accepted explanation through the adapter. For `v3`, summary → `markdown`, keyPoints → `keyPoints`, diagram → `mermaid`, table → `table` and evidence → `evidence`. For legacy v1/v2 (no `format`), summary → `markdown`, the `{nodes, edges}` diagram → `mermaid` (named via `legacyDiagramSource`, never raw ids) and evidence → `evidence`. `roleWithinParent` and `interactions` remain operator-only, as in CLA-260. An explanation with no summary, key points or evidence adapts to nothing.
3. Each source is validated separately, and then the planner orders the candidates.

Default recipes (`DEFAULT_BLOCK_RECIPES`). Candidates a recipe does not name keep their composition order at the end:

- **container**: summary → keyPoints → related → parent → dependencies → dependents → diagram → children → table → evidence
- **softwareSystem**: summary → keyPoints → **children (containers)** → related → parent → dependencies → dependents → diagram → table → evidence

LLM-emitted `nodeRefs` are a follow-up. They would be enrichment-provenance nodeRefs validated the same way, and would need a prompt/contract change that this ticket does not make.

## Planner contract

```ts
interface BlockPlanner { name; plan(input: BlockPlanInput): BlockPlan | undefined }
BlockPlanInput = { node: { id, kind, size: { children, dependencies, dependents } }, revision?,
  context: { mode: 'overview' } | { mode: 'ask', question }, candidates: { id, type, provenance }[], budget: { maxBlocks } }
BlockPlan = { order: string[]; reasons?: Record<id, string>; source: 'default' | 'planner'; fallback? }
```

- A planner only selects and reorders **existing candidate ids**. It never sees or supplies block content, only ids, types and provenance.
- **Omission policy.** A future planner may **omit** candidate blocks, within the budget, as part of select + reorder. The default planner **never omits**: it orders every candidate, and the budget of 16 is above the at most 11 candidates the composer builds. A planner may do nothing else.
- `resolveBlockPlanner(flags, remote)` only selects: `remote` when `remotePlanner` is on and a planner is supplied, otherwise `defaultBlockPlanner`.
- `runBlockPlanner(planner, input)` is the **single place** a plan is produced and validated. The default planner is trusted. Any other planner's output goes through `validatePlan`, which rejects an unknown id, a duplicate id, an empty order or an order over budget. The default recipe then applies with the reason recorded (`{ source: 'default', fallback }`), and it also applies when the planner throws (`planner failed`) or returns `undefined` (`planner unavailable`). Reasons are clipped to 120 chars and never rendered as facts.
- The interface is synchronous on purpose. A remote planner answers from a cache keyed by node + revision and returns `undefined` on a miss, so the Overview never waits on a model. A cached plan plus its candidate ids makes the ordering replayable. The Jev planner below implements this.
- A remote planner sends only candidate ids and types. The server derives each block's bounded preview from the publication itself, and a model judges from that preview, never from the full content or from anything the caller supplied.

## Jev planner (CLA-149 phase 2)

Status: pilot, **off by default** on both the server and the client. The flow is deterministic first, Jev second. The composer builds and validates every candidate, and Jev only reorders and selects them.

**Turning it on.** On the server, set `OKIE_JEV_BLOCK_PLANNER=on` and `JEV_API`. The planner writes `<OKIE_SCAN_ROOT>/block-plans/`, so never point `OKIE_SCAN_ROOT` at another checkout's scan root. Clone the fixtures into a scratch root instead (see operations.md). The caps are documented in `docs/qa/operator-workflow/operations.md`. In the browser, open a published atlas (`/r/<owner>/<repo>`) with `?planner=jev` (captured at boot, before the app rewrites the URL, and kept for the page's lifetime), or run `localStorage.setItem('okie.blockPlanner', 'jev')` and reload to keep it on. To see which order applied, turn on dev mode (`Shift+Alt+D`). It adds a small "Order: Jev planner" or "Order: default (…)" note above the blocks (for example "Order: default (Jev plan cached for next visit)"), with the per-block reasons in the note's tooltip. Readers without dev mode never see planner reasons.

**Client** (`blocks/jevBlockPlanner.ts`):

- `jevBlockPlanner` is the `BlockPlanner` that `useOverviewBlockPlanner` passes through `resolveBlockPlanner({ remotePlanner }, jevBlockPlanner)`. `App.tsx` is untouched.
- Its synchronous `plan()` answers from a cache keyed by publication version + node + sorted candidate `id:type` set. On a miss it returns `undefined`, so the default order renders immediately, and starts one background `POST /api/block-plan`.
- **No reorder after paint.** Each Overview view remembers the candidate sets it composed without a plan. A plan that arrives while that node is on screen is cached, not applied: the view keeps the default order and the dev note says "Jev plan cached for next visit". Opening the node again applies it.
- **Terminal vs transient answers.** `disabled`, `no-global-cap`, `invalid-*`, budget reasons and other 4xx are cached for the session, so a disabled server is asked once per node. `busy`, `rate-limited`, `timeout`, `provider-failure`, network errors and 5xx are retried on a later `plan()` after 2 s and then 8 s, at most 2 retries per key per session, and then treated as terminal.
- `runBlockPlanner` still validates every plan. Unknown ids, repeats or an over-budget order fall back to the default recipe.
- The scan identity is the immutable publication `{ slug, versionId }`, set at boot (`blockPlannerScan.ts`). Drafts, portable atlases and unpublished scans have no identity, so the planner never asks for them.
- Only the Overview asks. For Ask (`context.mode: 'ask'`) the planner returns `undefined`.

**Request** (bounded, strictly validated; unknown keys are rejected):

```ts
{ scan: { slug, versionId }, nodeId, node: { kind: 'container' | 'softwareSystem' },
  context: 'overview', budget: { maxBlocks ≤ 16 },
  candidates: { id, type }[]  // ≤ 16, unique
}
```

- Each candidate id must be one of the 11 ids the composer builds, with that id's type. Caller previews, size and provenance are not accepted.
- **Server-derived facts.** The server accepts only the slug's **current** publication (`versionId` must equal it, else 404). Per artifact it keeps a small id → facts index (name, summary, parent, named children and relations, explanation facts) for containers and systems, not the parsed snapshot. Node size, the name and every preview come from that index. A candidate the node cannot produce (e.g. `relations:dependents` on a node with no dependents) is a 400.
- Previews: the first 240 chars of the summary; **all** key points joined, up to 400 chars; the title for a diagram or table; a citation count for evidence. Relations, children and nodeRefs show the count plus the first 3 distinct entities as `Name (label, label)`, e.g. `Direct dependents: 2 nodes — atlas-gpu (dependsOn); atlas-wasm (dependsOn)`. Names and labels are ≤40 chars.
- **Cheap guards first.** The kill switch, the required global cap and the per-IP request window run before the body is validated, before operator state is read and before any snapshot is read. Operator state is read at most once per request, and the current publication is cached for 15 s.
- The request body is capped at 16 KB (padding counts), and the Jev body at 24 KB.

**Question** (`block-order-v2`). Each node gets one Jev request, with one Choice per candidate. The state holds only the node's kind, name and size plus the server-derived previews. The question describes the levels only; it does not encode the default recipe. The levels are:

- `lead`: the first thing a reader of this node needs
- `early`: helps a reader quickly grasp the node's role or structure
- `later`: reference detail
- `omit`: adds little for this node

Jev never writes text. A block's reason is its chosen level's fixed description plus that level's probability, e.g. "Later (59%): Useful reference detail…".

A Score (0–3) would give the expected rank directly. Choice was kept for three reasons: the explicit `omit` level with its own confidence gate, the named levels in the reasons, and reuse of the shared `validateJudgmentAnswers`.

**Order and selection** (`deriveBlockPlan`):

- Order is the expected rank Σ p(level)·rank(level), with lead = 0 through omit = 3. Ties keep the default order.
- A block is omitted only when `omit` is Jev's choice with confidence ≥ `BLOCK_PLAN_OMIT_THRESHOLD` (0.8, provisional).
- The lead summary is never omitted. That is `enrichment:summary`, or `summary` when there is no enrichment summary.
- The order is then capped to `budget.maxBlocks`, and if the cap would cut the lead it is put back at index 0.
- Jev rounds probabilities to 2 decimals, and a live answer summed to 0.99. Rounding drift of up to ±0.02 is renormalised in the planner only, and the shared validator stays strict. Anything else invalid falls back.

**Responses.** A plan comes back as `{ state: 'planned', order, reasons, omitted, source: 'jev', cacheKey, modelId, questionVersion, replayed }`. Otherwise the response is `{ state: 'unavailable', reason }`, with one of these reasons: `disabled`, `no-global-cap`, `no-provider`, `planner-budget`, `global-budget`, `rate-limited`, `busy`, `provider-failure`, `timeout`, `invalid-response`, `invalid-data`. An invalid request gets a 400, and an unknown scan or node a 404. The client falls back to the default order on every non-plan answer. Every fallback except `disabled` is logged server-side as a key-free counted line, `block-plan fallback reason=<reason> count=<n>`.

**Cache and replay.**

- Key: (publication version, node, sorted candidate `id:type` set, question version, model). Previews are derived from the version, so they are not part of the key.
- Answers live in an in-memory LRU plus `<scan root>/block-plans/<versionId>.json`. Each version's file is read into memory once (LRU of 8 versions), re-validated on load, and rewritten atomically (temp file + rename).
- Identical requests never call Jev twice, including concurrent ones.

**Evaluation** (`scripts/evaluate-block-planner.mjs`, jev-1.13.0). All runs covered the thiss/okie system and all 10 containers of a local publication. The real web composer decides the candidate ids and the server's derivation supplies the previews and size (`--capture`, from copies of the artifact files) into `fixtures/judgments/block-planner/nodes.json`.

Run 1 (2026-09-28, list previews were counts only): 11 requests, 29,777 input tokens, about $0.0013, latency p50 266 ms.

- 10 nodes were planned. atlas-protocol failed strict validation (a probability sum of 0.99), which led to the rounding renormalisation.
- The diagram moved straight after the summary on all 5 nodes that have one, and key points stayed third or better except on @okie/scan.
- The observed lists were shuffled among themselves at about 45–65%, which is noise.

Run 2 (2026-09-29, list previews with names): 11 requests, 30,962 input tokens, about $0.0013, latency p50 271 ms, max 420 ms. All 11 nodes were planned. The summary still led every node, and nothing was omitted (the strongest omit lean was 51%).

- **Better:** the diagram is still second wherever there is one. Children now mostly sit after the relations and above evidence. Dependencies of @okie/web and atlas-engine lean towards `omit` (37–51%), which matches their thin one-line content.
- **Worse:** with names in the previews, Jev promotes the one-line parent (`okie (softwareSystem)`) to second place on 7/11 nodes, at only 43–55% `early`. Key points fall below one or more relation lists on 9/11 nodes, judged `later` at up to 82%. The @okie/scan result from run 1 is now the common pattern. On a small container like atlas-wasm, key points land after all three relation lists and the children.
- **Reading:** the key-points preview is three truncated fragments, which Jev reads as reference detail, while a list preview with names reads as orientation. The planner orders by that impression, not by the author's "start here" intent.

No new guard was added after run 2. Pinning key points or demoting the parent would put a second recipe inside the planner.

Run 3 (2026-09-29, server-derived previews, key points shown in full up to 400 chars, question `block-order-v2`; this is the recorded `replay.json`): 10 requests, 28,667 input tokens, about $0.0012, latency p50 254 ms, max 461 ms. The run cap of $0.03 admitted 10 reservations of $0.003, so "Build & fixture tooling" was refused (`global-budget`) and falls back to the default order in replay too.

| Node | Key points position (run 1 / 2 / 3) | Second block (run 1 / 2 / 3) |
|---|---|---|
| okie | 2 / 2 / 2 | diagram / diagram / diagram |
| @okie/server | 1 / 2 / 1 | keyPoints / parent / keyPoints |
| @okie/web | 2 / 3 / 2 | diagram / diagram / diagram |
| atlas-engine | 1 / 2 / 2 | keyPoints / parent / parent |
| atlas-gpu | 1 / 3 / 2 | keyPoints / parent / parent |
| atlas-protocol | – / 3 / 3 | – / parent / diagram |
| atlas-wasm | 1 / 5 / 5 | keyPoints / parent / parent |
| @okie/architecture | 2 / 3 / 1 | diagram / diagram / keyPoints |
| @okie/scan | 5 / 5 / 5 | diagram / diagram / dependents |
| @okie/scene-compiler | 1 / 4 / 3 | keyPoints / dependents / dependents |
| Build & fixture tooling | 1 / 2 / – | keyPoints / parent / – |

Positions are 0-based; the summary (0) led every planned node in every run, and nothing was omitted in any run. The default recipe puts key points at 1.

- Key points in the top three: run 1 9/10, run 2 4/11, run 3 6/10.
- A relation list second: run 1 0/10, run 2 7/11, run 3 5/10.
- Full key points recovered some ground (@okie/server and @okie/architecture put them second again, @okie/web and atlas-gpu moved them up), but the parent or dependents list still comes second on half the nodes, and atlas-wasm and @okie/scan still put key points after every relation list.

**Verdict.** Jev's order is not better than the default recipe on this set. Run 3 is closer than run 2, but it still demotes the author's "start here" points below one-line graph lists on about half the nodes, and a browser QA pass found the run 2 orders worse on most nodes. The planner stays **off by default**. The plumbing (server-derived previews, caches, guards, no reorder after paint) is sound and can stay dormant. Before switching it on, the remaining levers are: collapsing a single-item parent into the identity header so it stops competing as a block, and evaluating against labelled orders rather than impressions.

## Ask (CLA-265) reuse

Ask renders answers with the same catalog, validator and registry. The composer builds candidates for the nodes the answer touches, and the planner is called with `context: { mode: 'ask', question }` so it can rank existing blocks by relevance to the question. The same validation, fallback and caching rules apply. Ask never gets a renderer or block type of its own.

## Security

- There is no generic HTML/JS block, no fetch, no arbitrary URL, no dynamic import and no script path. Block renderers never inject HTML. Text is markdown-lite rendered as React elements, and the only SVG inserted is Mermaid's output after its existing strict, double-DOMPurify pipeline, under the block's own source cap.
- The only actions are the existing callbacks: `onOpenEntity(id)` with an id validated against the snapshot, and `onOpenEvidence(evidence)` with a validated relative path and lines. Blocks cannot name or add actions.
- The block type string is never used as a dynamic lookup key outside the fixed registry.

## json-render decision

**Decision: direct React.** `@json-render/*` is not added. It was prototyped outside the repo (json-render 0.21.0 core + react, zod 4.6.5, React 19.2) with the same four blocks (markdown, keyPoints, nodeRefs, evidence) and the same leaf components. Both versions were rendered to static markup and compared. All of the measurements are recorded here, so the doc doesn't depend on the prototype files:

| | direct React | json-render |
|---|---|---|
| bundle added, min+gz (esbuild, react/react-dom external) | **846 B** (1,914 B min) | **112,945 B** (518,259 B min). By input: zod 453,029 B, `@json-render/core` 40,061 B, `@json-render/react` 22,057 B. That is close to the whole `App` chunk (~129 KB gz). |
| new deps | none | `@json-render/core`, `@json-render/react`, `zod` ^4 (the repo has no zod today) |
| glue lines (4 types) | 12 | 46 (catalog + registry + array→flat-element-map + providers) |

React version: `@json-render/react` peers on react `^19.2.3`. The installed React (19.2.7) satisfies it, so adopting it would only need a range bump in `apps/web/package.json` (currently `^19.1.0`), not a React upgrade.

What it offers that we don't need here: LLM prompt/JSON-schema generation from the catalog, streaming/patch specs, state binding, visibility conditions and form validation. We don't let models author layout, so those features have nothing to do.

What it does **not** give us:

- **It is not an authorization boundary.** `catalog.validate` returned `success: true` for a 9-item keyPoints (schema max 8), a numeric `text` and an unknown `href: "javascript:1"` prop, which it passed through. With more than one component, element props are typed as `record<string, unknown>`, so per-component zod schemas only apply if we call them ourselves.
- It resolves expressions in props at render time. `{ "$state": "/secret" }` in a text prop rendered the state value (`SESSION-STATE`), which gives model text an interpretation surface we would have to strip.
- Validation is whole-spec, with no per-block drop-with-note and no provenance or id namespace. We would keep our validator anyway.

Fit: our shape is a flat ordered array. json-render wants a rooted element tree/map, so the order has to be re-encoded as a root's `children`.

Revisit only if models start authoring nested layout, which the product direction rules out.
