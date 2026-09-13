# Operator review UI QA

The `/operator` route first requests `GET /api/operator/session`. It renders the workspace only for `{ "operator": true }`; an unsigned or non-operator response does not disclose run or draft metadata and gets the normal GitHub sign-in link with `/operator` as its return target.

The operator client uses these contract routes:

- `GET`/`POST /api/operator/runs`, `GET /api/operator/runs/:runId`, and `POST /api/operator/runs/:runId/cancel`
- `GET /api/operator/drafts/:draftRevisionId`, `GET /api/operator/drafts/:draftRevisionId/bundle`
- `POST` retry, refresh, and publish routes beneath the selected draft

Draft scope rows use the foundation DTO: `scopeId`, optional `parentScopeId`, `name`, `state`, `stale`, optional accepted `explanation`, `explanationVersionId`, `diagramError`, and attempt history. The inspector shows accepted summary, role, interactions, evidence, attempt error, and an expandable Mermaid view made from validated structured diagram IDs. Active runs poll every five seconds and stop on terminal state, unmount, or selection change. A selected draft stays pinned until the operator chooses **Review newer revision**.

Manual browser pass once the controller is integrated:

1. Sign in as a configured operator and open `/operator`; submit a public GitHub URL. Confirm a new run appears with durable state and cancel changes its displayed state.
2. Open an awaiting-review draft. Select scopes with accepted, failed, and stale states. Confirm evidence and Mermaid expansion render for an accepted explanation.
3. Retry one scope and verify the UI reports that siblings remain pinned. Refresh only the listed stale ancestors.
4. Open **Preview pinned revision**. Confirm the actual atlas canvas, story, source, and diagram surfaces render. Select an explained atlas node and confirm its accepted explanation, role, evidence, and expandable diagram are in the existing inspector. Return to review and verify the same run and draft remain selected, with no local portable-session control or imported draft.
5. Try publication with an incomplete draft: the button remains disabled until coverage acknowledgement is checked. Simulate a 409 and verify the review context reloads with a clear re-confirmation message.

Automated coverage: API route tests, review-state flow tests for run progress/new-draft pinning, stale selections, and 409 acknowledgement reset, plus diagram sanitization/name-label tests are in `apps/web/src/operator/*.test.ts`. Web typechecking passes using read-only links to the already-generated main-worktree WASM and stress fixture; they are not committed or regenerated here.
