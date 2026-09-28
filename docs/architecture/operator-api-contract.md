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
| POST `/api/operator/drafts/:draftRevisionId/refresh` | `{ scopeIds }` | 202 `{ run, draftRevisionId }`; explicit stale scopes only, run as one batch-retry pass (shared ancestors re-reduce once, one revision installed) |
| POST `/api/operator/drafts/:draftRevisionId/publish` | `{ expectedCurrentVersionId?, acknowledgeCoverage }` | `{ publication }`; 409 `code: "publication_stale"` on stale current pointer/revision |

Errors carry a stable machine-readable `code` next to the display-only `error` text; clients decide on the code, never the text: 401 `session_expired` (no verified session), 403 `not_operator` (signed in, not on the allow-list — e.g. removed mid-session) or `csrf_rejected`, 409 `run_active` (a pass is queued/running) or `draft_superseded` (with `currentDraftRevisionId`) on retry/refresh, and 409 `publication_stale` on publish.

A scope with no attempt on the requested revision lists the run's latest attempt for it from an earlier revision of the same run (a full run's attempts live on its pre-enrichment draft; a retry's on the revision it started from), so its error stays visible. That lineage attempt is marked `inherited: true` and never changes the scope's state or metrics (the web client skips it when summing tokens, cost, and latency).

Scope rows include identity/parent/name, C4 `kind` and `depth`, an optional `path` (the scope's primary repository-relative source path, from its first source ref; used for operator list search and tooltips, never a server filesystem path; absent when the scope has no source ref or on older servers), an optional operator-only `metrics: { costUsd?, totalTokens?, updatedAt? }` summary of the attempts behind the scope's current state (this draft's attempts for the scope when it has any, else the attempt an enriched sidecar's explanation row names — those live under the pre-enrichment draft — plus the row's install time; cost is measured, else estimated; omitted when nothing is known, and never included on public read routes), latest attempt state, accepted explanation/version/evidence, stale flag and validation diagnostics. Usage distinguishes measured cost, estimated cost and unknown cost. Events have stable IDs and can be paginated; an unbounded complete log should not be returned by default.

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
