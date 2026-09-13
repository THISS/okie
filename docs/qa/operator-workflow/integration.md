# Operator workflow integration

Implementation underway on `codex/operator-workflow`, based on accepted main `2c7a7e7`. No implementation acceptance or deployment is claimed.

## Ownership

| Worktree | Developer | Owned work | State |
| --- | --- | --- | --- |
| `.okie-review/worktrees/operator-foundation` | Terra low | Durable store/publication; operator HTTP/controller and main wiring | Foundation integrated; HTTP building |
| `.okie-review/worktrees/operator-access` | Terra low | New operator identity/CSRF helpers and focused tests | Integrated; five tests pass |
| `.okie-review/worktrees/operator-enrichment` | Terra low | Runtime scheduler plus real scan/store/budget runner bindings | Runtime integrated; runner building |
| `.okie-review/worktrees/operator-ui` | Terra low | Operator workspace, API client, draft App preview and contextual explanation UI | Building CLA-135 |
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

Shared foundation contracts, server execution integration, hierarchical scheduler, operator UI, durable usage instrumentation, full repository gates, Astra low browser acceptance, and Astra medium final review remain unfinished.

## Integrated increments

- Shared contract commit `9d61d45`: separate repository/source, run, draft, attempt, artifact and publication records. Further enrichment provenance fields are being developed with the store owner.
- Operator access commit `ff56db9`: stable numeric GitHub account allowlist, safe browser access result, 401/403 distinction and explicit-origin mutation guard. Server TypeScript compilation and all five focused tests pass after integration. This helper is not yet wired into running scan endpoints; current hosted behavior is unchanged until the HTTP/controller slice lands.

Foundation and enrichment modules were integrated in commits `6296a7d`, `add9827`, `f96d78f`, and `906226a`. Server compilation and 15 focused tests pass together. Follow-ups addressed fixed-clock ID collisions, interrupted publication retry, dead/live lock ownership, actual current-pointer draft bases, gateway model fields, coordinator admission, unavailable gateway state and structured diagram references. Full acceptance is still pending.

The active teams now own operator HTTP/controller, runtime runner/budget bindings, and the review UI. Their shared route contract is `docs/architecture/operator-api-contract.md`. No claim of finished endpoint or browser behavior is made.

## Integrated verification update

Operator HTTP, private portable draft preview, published explanation context, targeted retries, version-aware source/neighborhood resources, and review UI are now integrated locally. The first combined operator suite passed 21 tests. Subsequent HTTP acceptance covers identity/Origin gates, idempotent enqueue, raw portable preview, and public denial of draft IDs. Bootstrap regression verifies that an earlier publication remains pinned after a newer publication is created.

Coordinator integration fixed full explanation DTOs, untouched scope names, run-wide usage across draft revisions, unknown/zero cost reporting, durable concurrent token reservations, and bootstrap publication identity. Publication validation must compare the portable repository URL/source commit and matching artifact contents; scanner semantic repository IDs differ from operator owner/repo keys.

The first repository `pnpm check`, `pnpm test` (including 115 web files / 1035 web tests), and `cargo test --workspace` passed on the integrated baseline before the remaining cancellation/budget/refresh changes. Golden excerpts were regenerated for App inspector context and the evidence-row hash deliberately updated from `43720d17` to `76ace2ea`. Final gates will cover remaining changes.

Remaining acceptance: budget binding and cancellation; failed retry preserving accepted content and stale metadata in the new artifact; explicit ancestor refresh; publication validation regression; production config binding; controlled full-flow browser QA and final Astra medium review. No browser pass, deployment, public publication, push, or main merge is claimed. A separate loopback QA harness is being prepared at `.okie-review/operator-qa` with fake auth/gateway and a real local scan; it does not call a paid provider.
