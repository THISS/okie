# Operator workflow HTTP contract

Implementation contract for CLA-133/CLA-135. These routes are not yet wired. All identifiers come from `apps/server/src/operatorContracts.ts`; the controller must not expose credentials or internal filesystem paths.

## Routes

| Method and route | Request | Response |
| --- | --- | --- |
| GET `/api/operator/session` | GitHub session cookie if present | `{ operator: boolean }`; no allowlist disclosure |
| GET `/api/operator/runs` | Operator session | `{ runs: OperatorRun[] }`, newest first, bounded |
| POST `/api/operator/runs` | `{ url, idempotencyKey }` | 202 `{ run, deduped }`; normalize public GitHub input with existing parser |
| GET `/api/operator/runs/:runId` | Operator session | `{ run, draft?, attempts, events, usage }` |
| POST `/api/operator/runs/:runId/cancel` | Empty object | `{ run }`; durable cancellation checked before further work |
| GET `/api/operator/drafts/:draftRevisionId` | Operator session | `{ draft, source, scopes, usage, currentPublicationVersionId? }` |
| GET `/api/operator/drafts/:draftRevisionId/bundle` | Operator session | Valid portable atlas JSON for the immutable selected revision |
| POST `/api/operator/drafts/:draftRevisionId/retry` | `{ scopeId }` | 202 `{ run, draftRevisionId }`; selected scope only |
| POST `/api/operator/drafts/:draftRevisionId/refresh` | `{ scopeIds }` | 202 `{ run, draftRevisionId }`; explicit stale ancestors only |
| POST `/api/operator/drafts/:draftRevisionId/publish` | `{ expectedCurrentVersionId?, acknowledgeCoverage }` | `{ publication }`; 409 on stale current pointer/revision |

Scope rows include identity/parent/name, latest attempt state, accepted explanation/version/evidence, stale flag and validation diagnostics. Usage distinguishes measured cost, estimated cost and unknown cost. Events have stable IDs and can be paginated; an unbounded complete log should not be returned by default.

## Access and publication rules

- Only the session probe is publicly readable. All remaining operator routes, including bundles, reject unsigned callers with 401 and non-operators with 403 before revealing existence or metadata.
- Cookie-authenticated mutations require the explicit configured public Origin. The operator access helper ignores forwarded host headers; configuration must name the actual browser origin behind a proxy.
- Existing `/api/scans` submission/list/detail routes must no longer provide an alternate non-operator path into hosted scans or draft metadata. Preserve the public atlas read routes, not self-service submission behavior.
- No draft contents are served below `/scan/`. The public bootstrap resolves an immutable publication reference and carries that reference through neighborhood, excerpts, source, scene/story and embed metadata. Do not bind those resources only to the source SHA: enrichment versions can share a commit.
- A current-version switch is atomic. Retained published artifacts may service version-pinned in-flight reads; this is resource consistency, not a public version-history listing. Retention/access policy must be explicit before deployment. Draft and unpublished artifact IDs never grant public access.
- Publish must validate the complete artifact and freeze the selected draft revision. Acknowledged incomplete, failed or stale enrichment may publish; stale explanations remain labelled. Later completions create another draft.
- Publishing errors do not expose storage paths or corrupt the prior public version. Read current publication after a conflict so the UI can refresh its review context.

## UI integration

An operator workspace owns run administration and preview. Draft previews use the captured portable bundle and existing atlas/source/diagram components; they do not replace the public atlas or browser-persist the draft into the user's unrelated local portable viewer. Selecting a draft revision pins its preview until the operator chooses a newer revision.

The normal public repository URL continues to show the latest published atlas. Ask Atlas and public history browsing are unchanged by this contract.
