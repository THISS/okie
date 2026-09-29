# Operator enrichment prompt and explanation content (v3)

Implementation: `apps/server/src/operatorEnrichment.ts` (`OPERATOR_OUTPUT_SCHEMA_PROMPT`,
`operatorRequestBody`, `validateOperatorExplanation`). Introduced by CLA-260; replaces the v2
prompt that asked for `roleWithinParent` and `interactions`.

## Voice

Each explanation is the note the owner of an area would give a new teammate opening it for the
first time: plain, short sentences, what it is and why it matters first, then a few pointers worth
following. It never lists dependencies or dependents; the atlas already draws those edges.

## Request

One chat-completions request per scope (`promptVersion: "operator-enrichment/v4"`, JSON mode; v4
added claim mapping for CLA-145, and stored content stays `format: "v3"`). The
system message spells out the output shape and lengths, in words and well under the validator's
character limits, and includes one worked example about an unrelated service. A parent scope's
system message adds a synthesis instruction: say how the children fit together, which child to
read first, and where the seams are, without walking through the children one by one.

The user message carries `{ promptVersion, scope: { scopeId, name, kind, facts, allowedEvidence }, children }`.
A child travels up as `{ scopeId, name, kind, summary, keyPoints }` for v3 content, or
`{ scopeId, name, kind, summary }` for legacy v1/v2 content. `name` and `kind` come from the scan,
so a parent calls a child `@okie/scan` rather than `packages-scan`. This differs from the CLA-260
contract's child shape `{ scopeId, state, summary, keyPoints }`: `name` and `kind` are added, and
`state` is removed. The difference exists only in the prompt input; stored content and the web DTO
are unchanged.

A child with no explanation (failed or not run) is left out of the prompt, and no enrichment
state is sent. In a live v3 run, parents that saw `failed` children wrote enrichment status into
their prose ("Distrust `failed` parts…"), and those lines go stale on the next retry. The system
prompt also says never to mention enrichment or documentation status, failures or coverage. If no
child is explained, the parent gets the leaf prompt. The parent's input hash is unchanged: it still
covers every child with its state, name and kind, so stale and re-reduce behaviour are unchanged. Child evidence, diagrams and tables never
travel up. Each attempt records an input hash that includes the prompt version, so a v3
attempt's inputs can be told apart from v1/v2 ones. The hash is only recorded; it is not used to
skip or re-run scopes.

## Stored content

```ts
interface OperatorExplanationV3 {
  format: "v3";                 // stamped by the validator, never by the model
  summary: string;              // markdown-lite, <= 600 chars, <= 6 "- " bullets
  keyPoints: string[];          // 2-5 items, each <= 220 chars, inline markdown only
  diagram?: string;             // Mermaid, flowchart LR/TB only (see below)
  table?: { caption?: string; columns: string[]; rows: string[][] };
  evidence: Array<{ entityId?: string; path?: string; startLine?: number; endLine?: number }>;
  diagramError?: string;        // why an optional diagram and/or table was dropped
  claims?: Array<{ id: string; text: string; origin: "summary" | "keyPoint"; index: number; evidence: EvidenceRef[] }>;
  claimsNote?: string;          // why some or all claim mappings were dropped
}
```

### Claim mapping (prompt v4, CLA-145)

The model may write a key point as `{ "text", "evidence": number[] }` and add
`summaryClaims: [{ "text", "evidence" }]`. A claim's `evidence` lists 1-3 ref objects copied verbatim from
`allowedEvidence` (the form the prompt teaches, with an example). Each is resolved like the reply's `evidence`
(`resolveEvidence`) and must also appear in it. Zero-based indices into the reply's `evidence` array are still
accepted for compatibility.
The prompt says that a claim is one assertion, copied verbatim, and must never be split or reworded.
Ordinary code validates the mapping:

- A key-point claim is exactly the stored key point.
- A summary claim must be whole sentences of the stored summary, after whitespace normalisation.
  It starts at the start of the summary or after `[.!?]` and a space, ends at a sentence end or the
  end of the summary, and is at least 12 characters (`isSummarySentenceSpan`). The same rule
  re-validates stored claims on read.
- Ref objects must resolve to allowed evidence that the reply also cites. Indices must be in range.
- There are at most 8 claims and at most 3 refs per claim.

An invalid mapping is dropped with a `claimsNote`. It never rejects the explanation, and the prose
is never changed. The claim `id` is a hash of the origin, the text and the canonical evidence.
Content without `claims` (v1, v2 and earlier v3) reads as "not evaluated: no claim mapping". Claims
never travel to parents (`childPromptInput` sends only the summary and key points), and the public
`operator-explanations.json` route strips `claims` and `claimsNote`.
`explanationRowForJudgment` leaves them out, so judgment hashes for rows without claims are
unchanged. Operator claim checks are described in
[docs/qa/operator-workflow/operations.md](../qa/operator-workflow/operations.md#claim-checks-cla-145).

Legacy content (`{ summary, roleWithinParent?, interactions?, evidence, diagram?: { nodes, edges },
diagramError? }`, no `format`) that is already stored loads, publishes and renders unchanged.

## Validation

| Field | Rule | On failure |
| --- | --- | --- |
| `summary` | required; trimmed; <= 600 chars; <= 6 bullets; no active HTML (see below) | attempt fails (retryable scope) |
| `keyPoints` | required array of strings; list markers and newlines are normalised; 2-5 items; each <= 220 chars; no active HTML | attempt fails |
| `evidence` | >= 1 ref naming `allowedEvidence`: resolved by `entityId` (lines absent or equal to the allowed ref's; path absent or equal to the allowed ref's after `_`/`-` folding, so a different file rejects; an entity with several refs is disambiguated by lines, then exact path) and stored as the allowed copy, so a model's path spelling (`flow_story.ts` for `flow-story.ts`) is never stored; a ref without `entityId` must match exactly; `null` line numbers count as absent. A backticked span in `summary`/`keyPoints` is rewritten only when it exactly equals a path this reply cited as evidence under a different spelling, and it becomes the resolved allowed path; other spans are left as written | attempt fails, naming up to 3 offending refs (`entityId path:start-end`, `+N more`) |
| `diagram` | string; one ```` ```mermaid ```` fence is unwrapped; first line `flowchart LR` or `flowchart TB` (`TD` becomes `TB`); <= 12 nodes, <= 40 lines, <= 2000 chars; no second `flowchart`/`graph` header; no `%%`, `@{` shape data, `:::`, or `click`/`style`/`class`/`classDef`/`linkStyle` statements (at line start or after `;`); no URLs (`http(s):`, `//`, `ftp:`, `file:`, `data:`, `javascript:`); no HTML element tags; no entity ids | dropped, reason in `diagramError` |
| `table` | 2-4 columns (<= 40 chars), 1-8 rows of exactly one cell per column (<= 160 chars; numbers become text), caption <= 120 chars, no active HTML | dropped, reason in `diagramError` |

`null` optional fields count as absent. v2-only fields (`interactions`, `roleWithinParent`) and any
other extra field are ignored.

**HTML policy.** The web renders text as React text nodes, so this check keeps the contract honest.
It is not the XSS boundary. A false positive fails a whole paid scope, so the rule is narrow and
case-insensitive, and inline code spans are skipped:

- **Rejected:** anything a browser would treat as active markup:
  - HTML comments.
  - Any tag with a `name=value` attribute. `/` separates attributes, so `<svg/onload=…>` and
    `<img/src=x/onerror=…>` count.
  - A known HTML element with any attribute, such as `<dialog open>`.
  - Dangerous elements even when bare or closing: `script`, `style`, `iframe`, `frame(set)`,
    `object`, `embed`, `applet`, `svg`, `math`, `noscript`, `marquee`, `template`, `base`, `meta`,
    `portal`, `xmp`, `plaintext`.
- **Code-wrapped:** a bare mention of another known element, such as "the <summary> field" or
  "uses <p> elements", is wrapped in backticks and renders as code.
- **Left untouched:** generics and glued text, such as `Vec<Node>`, `Array<a>` and `x<em>y`.

A diagram is stricter: any known element tag drops it.

**Judgments.** `operatorJudgments.ts` and `sectionProfiles.ts` embed the scope's explanation row in
a judgment body limited to 24 KB. They use `explanationRowForJudgment`, which leaves out a v3 row's
diagram and table (up to about 9 KB at the caps). A judgment needs the claims, not the presentation.
Legacy rows pass unchanged, so their cached judgment hashes stay valid.

Validation rejects are not retried automatically: the retry-once rule covers only timeouts, transport
failures, and empty content. A rejected scope is recorded as failed with the reason, and the operator can retry it.

## Prompt experiment (CLA-260)

Live runs against `xiaomi/mimo-v2.6-pro` on a copy of the `operator-v1` fixture: the system, three
containers and two components, plus three extra containers for the final prompt. Four variants
were compared:

- **A**: baseline area-owner voice, with limits in characters.
- **B**: stronger first-day onboarding framing and a forced "**Start here:**" first key point.
- **C**: terser limits plus a worked example.
- **D**: C with the limits in words. D is the version that shipped.

A failed validation in 1 of 5 replies, B in 3 of 5 (key points over 220 characters, and one reply
with six), C in 1 of 5, and D in 0 of 13. D was also the easiest to read. The whole experiment cost
about $0.07.
