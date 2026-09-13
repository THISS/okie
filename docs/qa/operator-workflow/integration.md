# Operator workflow integration

Implementation is accepted locally on `codex/operator-workflow`, based on accepted main `2c7a7e7`. The checkpoints below retain the build and review history. Nothing has been pushed, merged to main, deployed, or published to a real environment.

## Ownership

| Worktree | Developer | Owned work | State |
| --- | --- | --- | --- |
| `.okie-review/worktrees/operator-foundation` | Terra low | Durable store/publication; operator HTTP/controller and main wiring | Integrated |
| `.okie-review/worktrees/operator-access` | Terra low | New operator identity/CSRF helpers and focused tests | Integrated; five tests pass |
| `.okie-review/worktrees/operator-enrichment` | Terra low | Runtime scheduler plus real scan/store/budget runner bindings | Integrated |
| `.okie-review/worktrees/operator-ui` | Terra low | Operator workspace, API client, draft App preview and contextual explanation UI | Integrated |
| Main integration checkout | Coordinator | Shared API decisions, integration, plan/evidence and Linear | Active |

Worktree dependency directories link to existing installed dependencies for read-only use. Builders must not mutate shared dependencies. Worktree commits are integrated only after bounded tests and contract inspection; final independent review remains reserved for Astra medium after integrated tests and Astra low browser QA.

## Integration invariants

- All draft routes, including raw artifacts and source, require an operator identity. Existing public job listing must not leak the new draft metadata.
- Public scan reads resolve publication identity once and carry that identity through subsequent resources. Do not mistake unchanged source commit/snapshot identity for unchanged enrichment/publication identity.
- Existing public artifacts remain served while a first versioned publication is prepared. Never point the public resolver at a writable draft directory.
- New scans attempt full deterministic language analysis and hosted enrichment by default. Publishing a valid deterministic draft before enrichment completes freezes that revision; later accepted work stays in a newer draft.
- Runtime model is configured through the existing OpenRouter gateway. Development model assignments are unrelated to runtime task roles.
- No paid live LLM requests in automated tests. Operator/browser acceptance uses controlled auth and gateway fixtures; real public publication is not part of implementation acceptance.

## Pending integration gates

Implementation, repository gates, Astra low browser acceptance and Astra medium independent review are complete. Updating Linear completion status remains pending destination authorization; see the final acceptance entry below.

## Integrated increments

- Shared contract commit `9d61d45`: separate repository/source, run, draft, attempt, artifact and publication records. Further enrichment provenance fields are being developed with the store owner.
- Operator access commit `ff56db9`: stable numeric GitHub account allowlist, safe browser access result, 401/403 distinction and explicit-origin mutation guard. Server TypeScript compilation and all five focused tests pass after integration. This helper is not yet wired into running scan endpoints; current hosted behavior is unchanged until the HTTP/controller slice lands.

Foundation and enrichment modules were integrated in commits `6296a7d`, `add9827`, `f96d78f`, and `906226a`. Server compilation and 15 focused tests pass together. Follow-ups addressed fixed-clock ID collisions, interrupted publication retry, dead/live lock ownership, actual current-pointer draft bases, gateway model fields, coordinator admission, unavailable gateway state and structured diagram references. Full acceptance is still pending.

The active teams now own operator HTTP/controller, runtime runner/budget bindings, and the review UI. Their shared route contract is `docs/architecture/operator-api-contract.md`. No claim of finished endpoint or browser behavior is made.

## Integrated verification update

Operator HTTP, private portable draft preview, published explanation context, targeted retries, version-aware source/neighborhood resources, and review UI are now integrated locally. The first combined operator suite passed 21 tests. Subsequent HTTP acceptance covers identity/Origin gates, idempotent enqueue, raw portable preview, and public denial of draft IDs. Bootstrap regression verifies that an earlier publication remains pinned after a newer publication is created.

Coordinator integration fixed full explanation DTOs, untouched scope names, run-wide usage across draft revisions, unknown/zero cost reporting, durable concurrent token reservations, and bootstrap publication identity. Publication validation must compare the portable repository URL/source commit and matching artifact contents; scanner semantic repository IDs differ from operator owner/repo keys.

The first repository `pnpm check` and `cargo test --workspace` passed. The web suite passed 115 files / 1035 tests, but the complete `pnpm test` later failed two scanner tests: the PATH selected an old Git that lacks `init -b`, and the extraction determinism check overlapped active integration edits. Full tests must rerun with `/opt/homebrew/bin` first in PATH and a stable checkout before acceptance. Golden excerpts were regenerated for App inspector context and the evidence-row hash deliberately updated from `43720d17` to `76ace2ea`. Final gates will cover remaining changes.

Remaining acceptance: budget binding and cancellation; failed retry preserving accepted content and stale metadata in the new artifact; explicit ancestor refresh; publication validation regression; production config binding; controlled full-flow browser QA and final Astra medium review. No browser pass, deployment, public publication, push, or main merge is claimed. A separate loopback QA harness is being prepared at `.okie-review/operator-qa` with fake auth/gateway and a real local scan; it does not call a paid provider.

## Final acceptance checkpoint (before independent review)

- Full stable-checkout `pnpm test` completed exit 0: architecture 125, scene compiler 122, scan 198 (one skip), server 188, web 1,036 passing tests. The earlier Git/PATH and active-edit failures were superseded by this clean run.
- `pnpm check`, `cargo test --workspace`, and production `pnpm build` completed exit 0. The final Overview placement change additionally passed its focused render tests, golden fixture acceptance and another production build; fixture regeneration produced no additional drift.
- Astra low real browser acceptance passed on the separate 4174/4181 fixture. See `browser-qa.md`: real 3,574-entity local scan, operator/anonymous access, pinned previews, budget-limited failure, successful App/protocol retry preserving siblings, bottom-up stale refresh, two partial publications, old public page pinning, stories, map/minimap, expanded diagrams, excerpts and full source tab. Full source and model replies were local test doubles; no real publication or paid scan was performed. Recording was unavailable; screenshots are retained.
- QA found accepted explanations in Details instead of Overview. Commit `4857bb6` corrected placement; Astra rechecked App/protocol Overview and diagrams, Details metadata, and an unenriched fallback node successfully.
- Astra medium independent review dispatched after these checks; findings and follow-ups remain the final gate. Source checkout frozen during review. No main merge, push, or deployment authorized or performed.

## Review corrections and regression evidence

Astra medium found four P2 issues: retries could overwrite newer sibling results; ancestor refresh could treat stale children as current; GitHub URL casing split publication identity; long repository names exceeded pointer filename limits. Corrections are integrated in `c5192a4`, `0904417`, and `557ee20`. Stale/busy API mutations now return 409, the runner guards installation with a revision comparison and records conflicts, old draft attempt freshness stays unchanged, and publication pointers use fixed-width digests with legacy reads.

The targeted browser recheck found a legacy mixed-case run could not create its next canonical draft. Commit `c44a82d` corrects comparison and revision numbering; its regression explicitly continues legacy revision 10 as revision 11. Recovery and revision navigation also clear obsolete error messages (`0942e4b`, `8ae120a`). Public source and accepted explanations remained intact through the reproduced failure.

Post-review gates: `pnpm check`, full `pnpm test` (1,674 passing TypeScript tests, one scanner skip), and `pnpm build` completed exit 0. After the migration correction, all 193 server tests passed; the final recovery adjustment passed all five runner tests and server compilation, and the navigation adjustment passed web typechecking. The prior Rust gate remains valid because no Rust source changed. Logs: `/tmp/okie-operator-{check,tests,build}-review.log`, `/tmp/okie-operator-server-migration.log`, `/tmp/okie-operator-recovery.log`.

Linear status updates were blocked by automatic approval review pending explicit destination authorization; local implementation and QA evidence continue independently. No issue has been marked complete by this final update attempt.

## Final technical acceptance

Astra low passed the final retry/conflict/recovery browser cycle at `8ae120a`: revisions 11 and 12 preserve the older pinned preview, stale retry reports a conflict, reviewing the new revision clears that alert, accepted siblings survive, and the new node's Overview/evidence/diagram and old published source remain available.

Astra medium's bounded recheck found one additional legacy pointer precedence case. Commit `aad68c6` selects the newest valid legacy case-variant pointer when no modern digest pointer exists, including tied timestamps; digest pointers remain authoritative. Server compilation and all 11 focused store/publication API tests passed. The reviewer independently reproduced the corrected case and accepted all four findings with no confirmed residual blocker. See `final-independent-review.md`.

The isolated 4174/4181 QA fixture was restarted with the final compiled backend. It uses fake authentication and a fake model with a cached real repository scan; it performs no paid calls or real publication. The original 4173/4180 processes were not restarted. Linear remains In Progress pending permission to send the completion summary to Clabrate's Okie project.
