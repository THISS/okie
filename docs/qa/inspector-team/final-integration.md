# Local inspector integration

Implemented in `/Users/brenton/sites/okie`; the user-facing web app remains at http://localhost:4173 and its updated scan server at http://127.0.0.1:4180. No commit, PR, merge, deployment, paid scan or rewrite of published scans was performed. Existing zoom, minimap and expanded Mermaid work was preserved against the initial working-tree hash manifest.

The inspector now follows explicit selection and preserves its tab. Sidebar lists show five items with counts and expansion. Canonical Calls/Called by and Uses/Used by remain available independently of map visibility; evidence and relationship reveal retain the selected entity. Dependency, code-structure and captured-story diagrams open in separate tabs, with Mermaid available. Historical source context and full-file links use the scanned commit. Deterministic extraction adds stronger binding resolution and evidence-backed module-export, reachable package-API and executable-file labels.

Astra high review and Astra low browser QA found and resolved wrong-scope Overview selection, incomplete code diagrams, expansion leaking between entities, cramped relation actions, false API/entry-point labels and a captured-flow crash. The actual `722ea2862304` published flow now opens with four ordered steps; source context expands from lines1201–1212 to1171–1242 at the exact same revision. The final information control uses an ordinary tooltip container with hover/focus and tap support; Escape is consumed locally so it cannot close the inspector.

## Validation

- `pnpm check`: passed.
- `pnpm test`: 1,583 passed, one skipped (including1,004 web tests).
- `cargo test --workspace`:81 passed, one ignored.
- `pnpm build`: final production build recorded in `/tmp/okie-inspector-team/final-build.log`.
- `git diff --check`: passed.
- Scan tests initially picked up an obsolete Git without `git init -b`; scan/server suites passed on rerun with `/opt/homebrew/bin` first in PATH. The final suite totals above include that corrected run.
- Golden source excerpts and demo fixtures regenerated; deliberate evidence-row hash updated to `77d88d5b`.
- Independent high-reasoning review cleared all reported findings, including final Escape propagation.

[Browser acceptance](./browser-acceptance.md) records actual interactions, screenshots and limits. It covers `/`, `/new`, the published Okie route, the root scan fixture, a paused guided-story step, selections, list expansion, map/minimap pan, canonical evidence and reveal, separate diagrams/Main return and live historical source loading. A final smoke pass used the actual user-facing port4173.

## Relationship motion verification

Functional browser acceptance is complete, including focus-before-click, hover without focus/tap state, tap and Escape. A synthetic scanner fixture verifies module exports, reachable package APIs, executable-file entry points, capped incoming calls and recursive calls. Source request cancellation tests exposed and fixed a stuck-loading A→B→A sequence; normal-transport browser navigation also passed. Controlled tests cover adversarial response timing and bounded caches.

The renderer's camera uniform was visible only to the vertex stage despite fragment-stage use. Correcting its binding visibility restored WebGPU; browser diagnostics confirm hardware acceleration and no previous validation failure. Independent Astra high review cleared the change, and all repository gates above passed afterward.

Relationship flights now stream camera and semantic projection to Canvas without rendering the full React shell every frame. Before/after WebGPU traces improved from roughly66–71ms moving-frame intervals to8.3–8.4ms median. Flight startup cancels pending wheel, pan, pinch, semantic-assist and publisher callbacks, rebases from the live camera, and defers routine diagnostic React updates until the flight ends. Terminal/interrupted state still commits to React/navigation. Astra high cleared the ownership fix and a fake-timer regression proves stale callbacks cannot overwrite a flight frame. Final WebGPU traces after the ownership/diagnostics follow-up pass: individual52 moving intervals at8.3ms median/17.7ms maximum, aggregate47 at8.3ms median/17.0ms maximum. Both endpoints/edge, original selection/Details and minimap alignment are browser-verified. Final published Okie → @okie/web → src/App.tsx hierarchy navigation also passes with scoped Overview, a nonblank map and aligned minimap. The inspector goal is complete locally.

## Scope and evidence limits

Existing published scans predate the new extraction labels; new metadata requires a new scan. Resolution is a supported TypeScript/JavaScript slice, not a complete multi-language call graph or arbitrary framework-registration detector. Historical fetches use anonymous public GitHub access; saved excerpts remain when retrieval fails. Adversarial source timing is established by controlled tests, not injected browser delays. Built-in rendered-frame trace exports provide animation evidence; they are not screen recordings.
