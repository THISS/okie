# Operator review UI QA

The `/operator` route first requests `GET /api/operator/session`. It renders the workspace only for `{ "operator": true }`; an unsigned or non-operator response does not disclose run or draft metadata.

The operator client uses these contract routes:

- `GET`/`POST /api/operator/runs`, `GET /api/operator/runs/:runId`, and `POST /api/operator/runs/:runId/cancel`
- `GET /api/operator/drafts/:draftRevisionId`, `GET /api/operator/drafts/:draftRevisionId/bundle`
- `POST` retry, refresh, and publish routes beneath the selected draft

Draft scope rows use the foundation DTO: `scopeId`, optional `parentScopeId`, `name`, `state`, `stale`, optional accepted `explanation`, `explanationVersionId`, `diagramError`, and attempt history. The inspector shows accepted summary, role, interactions, evidence, attempt error, and an expandable Mermaid view made from validated structured diagram IDs.

Manual browser pass once the controller is integrated:

1. Sign in as a configured operator and open `/operator`; submit a public GitHub URL. Confirm a new run appears with durable state and cancel changes its displayed state.
2. Open an awaiting-review draft. Select scopes with accepted, failed, and stale states. Confirm evidence and Mermaid expansion render for an accepted explanation.
3. Retry one scope and verify the UI reports that siblings remain pinned. Refresh only the listed stale ancestors.
4. Open **Preview pinned revision**. Confirm the actual atlas canvas, story, source, and diagram surfaces render. Return to review and verify no local portable-session control or imported draft remains.
5. Try publication with an incomplete draft: the button remains disabled until coverage acknowledgement is checked. Simulate a 409 and verify the review context reloads with a clear re-confirmation message.

Automated coverage: `apps/web/src/operator/api.test.ts` asserts the authenticated draft bundle and scoped mutation route construction. Typechecking is clean for the new operator sources; the isolated worktree lacks generated WASM and stress fixture outputs needed for a full web typecheck.
