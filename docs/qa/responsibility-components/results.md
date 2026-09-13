# Responsibility component slice validation

Branch `codex/responsibility-components`, based on main `6a65b89`. This is local
work only; no new PR, push, merge, publication, or paid enrichment was performed.

## Delivered behavior

- Optional `--component-map` layers reviewed, multi-file C4 responsibilities over
  deterministic source ownership. Partial maps preserve unmapped file components.
  Every retained declaration from a mapped file moves together; IDs, source ranges
  and code-to-code call evidence remain unchanged.
- Validation rejects the entire mapping on malformed input, ambiguous ownership,
  cross-container paths, collisions, or oversized authoritative evidence. The CLI
  retains the original graph, writes the rejection report, prints reasons, and
  exits with status 1. A null JSON map was verified end-to-end this way.
- Component overviews and Source show implementing files and declaration links;
  lists initially show five. A declaration outside the current drawable window
  loads its code neighborhood before navigating. Source evidence and dedicated
  source tabs remain pinned to the scanned commit.
- Omitted component layout reservations no longer paint blank rectangles owned
  by their container. Their layout occupancy remains intact. Browser QA used the
  actual published `722ea2862304` deep link, not just a fresh portable fixture.

## Artifact evidence

The reviewed example is `docs/examples/okie-component-map.json`. Its two-file
Semantic navigation boundary was checked against lens policy and engine source.

Full local scan of `6a65b895f8a6f23c3da7f254734933ef64e72a71`:

- 3,581 entities, 8,805 relations, 2,938 code-call relations.
- One authored component, two member files, 153 implementing declarations.
- Mapping bytes SHA-256: `4909f259122102f5a02567f3d56ffb45e639b6212f20dd2af7f1a2edf080e42a`.
- Portable artifact SHA-256: `1e2cccf529b6f6fd608dbd8853ad055b2e9438da5edfe565e13acdb0d59655f7`.
- Review copies remain locally in `.okie-review/responsibility-components/`;
  these generated artifacts are ignored by Git. The temporary public bootstrap
  file used for QA was removed.

The full scan records analyzer limitations; full mode is not a claim of complete
call-graph coverage. No live enrichment was needed for this authored example.

## Checks

- `pnpm check`: passed with local WASM build permissions. The initial sandboxed
  attempt stopped at wasm-opt; it was rerun with the required permissions.
- `pnpm test`: final stable run passed: 125 architecture, 125 scene compiler,
  209 scanner (one existing skip), 194 server, and 1,039 web tests. After the review fix, the affected web suite passed
  1,043 tests and the 125 compiler tests passed again.
- `cargo test --workspace`: passed.
- `pnpm build`: passed, retaining existing bundle-size warnings.
- `pnpm generate:fixtures`: regenerated the App and CanvasViewport source anchors;
  CanvasViewport moved from 5314–5319 to 5337–5342. Deliberate evidence hash
  `76ace2ea` → `85fbe931`.
- `git diff --check`: passed.

An earlier full test run overlapped an App edit and failed the scanner's
working-tree shuffle determinism test. The complete suite was rerun without
source edits and passed. This was not treated as an accepted failing test.

Browser observations and fix retests are recorded in `browser-qa.md`. They cover
cold published-route loading, zoom reversal, pan/minimap, authored components,
nonresident declarations, source tabs, paused guided steps and related routes.

## Limits and follow-ups

This slice adds explicit boundaries; it does not automatically discover all
architectural components. Membership is currently limited to 32 files per
component and 64 evidence items per aggregate relation by the existing schema;
excess is rejected explicitly, never silently truncated. Mapping-aware
hierarchical enrichment packets are documented as a follow-up.

Browser QA observed a remaining cold-load versus post-zoom difference in the
parent container's presentation. The blank component-grid defect is fixed;
complete visual equivalence and Figma-like smoothness across every node/level
are not established. The L4 sample was bounded and did not prove every possible
code reservation state. These broader zoom investigations remain separate from
the responsibility-component slice.

## Independent review

Astra medium found one P2: an older neighborhood request could complete after
a newer selection and override the scene and inspector. The fix guards
publication with request generation, navigation/selection identity, fixture
identity, and cancellation on close/unmount. Shared neighborhood caching can
still complete; obsolete requests cannot publish a scene or error. Four
controlled regression tests cover out-of-order loads, later selections,
and fixture/unmount cancellation. Typecheck, affected web/compiler suites and
production build passed again after this change.

Astra low final browser smoke passed after a correction to compare navigation
values rather than render-created object references. See `review.md` for the
review finding, resolution, and the agent-limit constraint on a second
independent pass.
