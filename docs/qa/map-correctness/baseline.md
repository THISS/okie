# Fresh Okie scan assessment

Scan completed successfully against commit `4504c6dd985ccd69a8da74241a468f70816b0f28` using the full local CLI. No application source edits or publication. Output: `atlas.okie.json` (14.6 MB), snapshot/view/scene/stories/timeline/extraction. 3,577 entities, 9,372 relationships, four stories. Counts: 3,346 code entities, 219 components, ten containers, one external system, one software system. Relationships: 3,145 calls, 5,286 uses, 849 dependsOn, 92 duplicates.

## Priorities

1. **Incorrect Rust relationships — fix before trusting the graph.** The captured `is_valid_color` body at `crates/atlas-protocol/src/geometry.rs:49–53` only checks each colour component with iterator/range methods. Yet the artifact emits calls to `Viewport::physical_width` and `Viewport::physical_height`, with evidence at lines 50 and 52. These are demonstrably wrong. Incoming calls from `Stroke::is_valid`, `Primitive::validate`, `SceneSnapshot::validate`, and `Timeline::validate_for` match source. The analyzer reports duplicate SCIP symbols, and `analyze-rust.ts` stores one definition per symbol with Map.set; collision handling is a plausible cause to investigate, not yet a proven root cause.

2. **TypeScript analysis environment and confidence.** The TypeScript adapter lists 2,728 limitations, including 586 TS2307 unresolved-module diagnostics and 931 ambiguous/dynamic call messages. Examples include Node built-ins, undici-types and @anthropic-ai/sdk. The JavaScript adapter repeats the same limitation list, so do not count these twice. The committed-tree scanner materializes tracked files in a temporary checkout; installed dependency context is not copied there. These scan diagnostics are not evidence the normal build is broken. Provision the committed analysis environment and distinguish unresolved-project gaps from genuinely dynamic dispatch. The current broad `semantic` label does not indicate how complete relationships are.

3. **Rust target coverage.** The adapter explicitly omits `crates/atlas-wasm/src/browser.rs`. This leaves the browser/WASM boundary underrepresented. Sixty-one of 496 Rust code nodes have no captured edges; that is a coverage signal, not proof every isolated node is incorrect. Evaluate target/feature configuration for browser code.

4. **Exposure classifications.** All 1,717 exposure annotations are moduleExport. No other exposure kind appears; the Rust public `is_valid_color` node has no exposure annotation. The output does not yet deliver the intended distinction between file exports, package public API, and supported framework entry points.

5. **Real explanation quality remains untested.** No entity descriptions were produced by this deterministic-only scan. The normal local gateway configuration reports OpenRouter model z-ai/glm-5.3-flash with no configured key. No real model request was made, and fake summaries were not substituted. A live enrichment evaluation needs configured credentials. The existing default budget is 16 requests / 200,000 tokens / $1 admission threshold; thousands of nodes cannot receive individual owner calls under that request cap.

## Recommendation

Fix false Rust edges first, then improve dependency/toolchain provisioning and per-area coverage reporting. Rerun this exact scan and compare the concrete bad-edge example and unresolved-module counts. After that, evaluate real bottom-up explanations on web, atlas-protocol, and the operator workflow with an explicit suitable budget. More edges or more summaries alone would not make the current artifact more trustworthy.

This is an artifact/source inspection, not a new browser rendering QA pass. Public site and prior scans were left unchanged.
