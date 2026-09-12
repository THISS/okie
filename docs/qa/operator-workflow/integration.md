# Operator workflow integration

Implementation underway on `codex/operator-workflow`, based on accepted main `2c7a7e7`. No implementation acceptance or deployment is claimed.

## Ownership

| Worktree | Developer | Owned work | State |
| --- | --- | --- | --- |
| `.okie-review/worktrees/operator-foundation` | Terra low | New server contracts, durable store, publication modules and focused tests | Building CLA-132 |
| `.okie-review/worktrees/operator-access` | Terra low | New operator identity/CSRF helpers and focused tests | Integrated; five tests pass |
| `.okie-review/worktrees/operator-enrichment` | Terra low | Hierarchical runtime scheduler, scope evidence and explanation validation, targeted retries | Building CLA-134 |
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

At this stage foundation and enrichment builders are the active implementation owners. Operator HTTP/controller and UI work is queued behind their finalized interfaces; no claim of finished endpoint or browser behavior is made.
