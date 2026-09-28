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

## Planner contract (future Jev)

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
- The interface is synchronous on purpose. The intended design is that a Jev planner resolves plans ahead of time into a cache keyed by **node id + revision** and answers from it, so the Overview never waits on a model, and a cached plan plus its candidate ids makes the ordering replayable. **That cache is a seam only; it is not implemented.** Today `revision` is an unused optional input, and a cache miss (`undefined`) falls back to the default recipe.

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
