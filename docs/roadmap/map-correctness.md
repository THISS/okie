# Map correctness and clarity

Start: main 929a4ee. Integration branch: codex/map-correctness. User authorized goal and delegation; no new push, merge, deployment or atlas publication is authorized.

## Work and ownership

- Terra `map_cards`, worktree `.okie-review/worktrees/map-cards`: reproduce blank card grid inside @okie/web; resolve foreground label/picking versus reserved/omitted shell behavior. Preserve anchored zoom, stable context and minimap alignment. Own renderer/semantic/scene compiler changes.
- Terra `map_rust`, worktree `.okie-review/worktrees/map-rust`: reproduce false SCIP relationships, preserve real callers, handle ambiguity, and improve browser/WASM target coverage. Own Rust analyzer and related regressions.
- Coordinator initially owns TypeScript investigation; a third Terra dispatch was refused by the agent thread limit. Reserved worktree `.okie-review/worktrees/map-typescript`: committed scan dependency/project resolution without using uncommitted source or silently installing/executing repository dependencies. Delegate when a slot becomes available.
- Coordinator integrates isolated commits and compares a fresh full scan with the baseline. Astra low performs real browser QA after integration; Astra medium independently reviews only after implementation, checks and browser QA are ready. Findings require fixes and relevant rechecks.

## Baseline and acceptance

Baseline artifact `/tmp/okie-fresh-4504c6d/atlas.okie.json`, report alongside it, source commit4504c6d (implementation now on main929a4ee):3577entities,9372relationships. Preserve durable baseline evidence before temporary files disappear.

1. @okie/web foreground cards at readable zoom have names and can be selected. Intentional omissions are clearly represented instead of a blank grid. Exercise L1–L4 inward/reverse zoom, pan and fit in web and atlas-protocol, checking stable geometry/minimap. Confirmed cause: a global omitted/reserved set removed components that remained resident in another band; compilation now applies omission per band.
2. `is_valid_color` must not call Viewport sizing methods. Retain evidence-backed callers from Stroke, Primitive, SceneSnapshot and Timeline. Add real collision/ambiguity regressions, not just edge-count tests.
3. Reduce avoidable TypeScript unresolved-module/project diagnostics (baseline586TS2307 and2728total limitations; JS repeats same list). Preserve immutable source identity and report missing dependencies and genuine dynamic dispatch honestly.
4. Include Rust browser/WASM code when the supported target environment is available; otherwise report exact limitations. Baseline explicitly omitted crates/atlas-wasm/src/browser.rs.
5. Fresh full scan comparison reports corrected and remaining cases. Run real OpenRouter enrichment on web/protocol/operator areas only using configured credentials and bounded budget. Current local gateway reports no key; do not substitute fake output. Evaluate meaningful contextual summaries, evidence and diagrams; document credential blocker if it persists.
6. Required gates: pnpm check, pnpm test, cargo test --workspace, pnpm build; regenerate pinned fixtures and deliberate evidence hash when affected. Browser exercises guided story to paused state, selected-node inspector, related routes and diagram/source navigation. QA evidence includes screenshots or video if capability available. Final independent review follows these gates.

Ask Atlas and unrelated public API classification expansion are not part of this pass. Existing scanner follow-ups remain visible in the scan comparison.

## Integration status

Card and Rust Terra changes are integrated locally. Coordinator TypeScript dependency-resolution work reduced the final observed unresolved-module count to2. All repository gates and sampled Astra low visual QA passed. Independent Astra medium review found a transitive dependency source escape; Terra fixed it with focused regressions, and Astra medium rechecked the fix with no remaining actionable findings. Final scan and gate reruns passed; the local goal is complete. Live enrichment remains unevaluated because the normal OpenRouter configuration has no key. See `docs/qa/map-correctness/results.md` for evidence and limitations.
