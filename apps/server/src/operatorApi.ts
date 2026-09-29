import type { IncomingMessage } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { authorizeOperator, authorizeOperatorMutation, operatorDenialBody, publicOperatorAccessView } from "./operatorAccess.js";
import type { GithubAuthService } from "./githubOAuth.js";
import { normalizeRepoInput } from "./repoUrl.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { canonicalOperatorRepositoryId, OperatorStore } from "./operatorStore.js";
import { OperatorWorkflow, type OperatorGlobalBudget, type OperatorWorkflowJob } from "./operatorWorkflow.js";
import { resolveScanGithubAccess } from "./githubAccess.js";
import { parsePortableAtlas } from "@okie/architecture";
import { MAX_CLAIM_CHECK_SCOPES } from "./claimChecks.js";
import { resolveClaimCheckConfig } from "./llmGateway.js";

export interface OperatorApiOptions { auth: GithubAuthService; allowedGithubIds: ReadonlySet<string>; publicOrigin: string; store: OperatorStore; publications: OperatorPublicationService; enqueue: (job: OperatorWorkflowJob) => void | Promise<void>; /** Process-wide operator ledger, when a global dollar cap is configured (shown as global remaining in run detail). */ globalBudget?: OperatorGlobalBudget; }
export interface OperatorApiResult { status: number; body: unknown; }
/** Upper bound on one batch retry selection. */
export const MAX_RETRY_SCOPES = 1024;
/**
 * Retry body: `{ scopeId }` (single, CLA-134 semantics) or `{ scopeIds, includeBelowCap? }` (batch, CLA-258).
 * Duplicates are removed; below-cap scopes need an explicit `includeBelowCap: true` in either form.
 */
export function parseRetrySelection(value: Record<string, unknown>, scopes: readonly { scopeId: string; state: string }[]): { scopeIds: string[]; batch: boolean } | { error: string } {
  const byId = new Map(scopes.map(scope => [scope.scopeId, scope]));
  const optIn = value.includeBelowCap === true;
  if (value.scopeIds === undefined && typeof value.scopeId === "string") {
    const single = byId.get(value.scopeId);
    if (!single) return { error: "known scope id required" };
    return single.state === "below cap" && !optIn ? { error: "below-cap scopes require explicit opt-in (includeBelowCap: true)" } : { scopeIds: [value.scopeId], batch: false };
  }
  if (!Array.isArray(value.scopeIds)) return { error: "scopeIds must be an array of scope ids" };
  if (!value.scopeIds.length) return { error: "scopeIds must not be empty" };
  if (value.scopeIds.some(scopeId => typeof scopeId !== "string")) return { error: "scopeIds must contain only strings" };
  const scopeIds = [...new Set(value.scopeIds as string[])];
  if (scopeIds.length > MAX_RETRY_SCOPES) return { error: `at most ${MAX_RETRY_SCOPES} scopes can be retried at once` };
  const unknown = scopeIds.find(scopeId => !byId.has(scopeId));
  if (unknown !== undefined) return { error: `unknown scope id: ${unknown}` };
  if (!optIn && scopeIds.some(scopeId => byId.get(scopeId)!.state === "below cap")) return { error: "below-cap scopes require explicit opt-in (includeBelowCap: true)" };
  return { scopeIds, batch: true };
}
/**
 * Claim-check body (CLA-145): `{}` checks every non-stale scope whose explanation has a claim mapping;
 * `{ scopeIds }` names known scopes (deduplicated, capped). A named scope without claims is refused.
 * Stale scopes are never sent to Jev: a selection with only stale scopes is refused with
 * `claim_scopes_stale` (refresh first); stale members of a mixed selection are skipped by the pass.
 */
export function parseClaimCheckSelection(value: Record<string, unknown>, scopes: readonly { scopeId: string; stale?: boolean; claimChecks?: { mapping: string } }[]): { scopeIds: string[] } | { error: string; code?: "claim_scopes_stale" } {
  const withClaims = scopes.filter(scope => scope.claimChecks?.mapping === "claims");
  const staleError = { error: "Every selected scope's explanation is stale; refresh it, then re-check.", code: "claim_scopes_stale" as const };
  if (value.scopeIds === undefined) {
    if (!withClaims.length) return { error: "no scope in this revision has a claim mapping" };
    const fresh = withClaims.filter(scope => !scope.stale).map(scope => scope.scopeId);
    return fresh.length ? { scopeIds: fresh.slice(0, MAX_CLAIM_CHECK_SCOPES) } : staleError;
  }
  if (!Array.isArray(value.scopeIds) || !value.scopeIds.length || value.scopeIds.some(scopeId => typeof scopeId !== "string")) return { error: "scopeIds must be a non-empty array of scope ids" };
  const scopeIds = [...new Set(value.scopeIds as string[])];
  if (scopeIds.length > MAX_CLAIM_CHECK_SCOPES) return { error: `at most ${MAX_CLAIM_CHECK_SCOPES} scopes can be checked at once` };
  const unknown = scopeIds.find(scopeId => !scopes.some(scope => scope.scopeId === scopeId));
  if (unknown !== undefined) return { error: `unknown scope id: ${unknown}` };
  const unmapped = scopeIds.find(scopeId => !withClaims.some(scope => scope.scopeId === scopeId));
  if (unmapped !== undefined) return { error: `scope has no claim mapping: ${unmapped}` };
  if (scopeIds.every(scopeId => withClaims.find(scope => scope.scopeId === scopeId)!.stale)) return staleError;
  return { scopeIds };
}
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
/** Authorization happens before any ID lookup, intentionally preventing existence inference. */
export async function handleOperatorApi(options: OperatorApiOptions, request: IncomingMessage, pathname: string, body?: unknown): Promise<OperatorApiResult | undefined> {
  if (!pathname.startsWith("/api/operator")) return undefined;
  const session = options.auth.sessionFromRequest(request); const workflow = new OperatorWorkflow({ store: options.store, publications: options.publications, enqueue: options.enqueue, ...(options.globalBudget ? { globalBudget: options.globalBudget } : {}) });
  if (pathname === "/api/operator/session" && request.method === "GET") return { status: 200, body: publicOperatorAccessView(authorizeOperator(session, options.allowedGithubIds)) };
  const mutation = request.method === "POST"; const access = mutation ? authorizeOperatorMutation({ request, session, allowedGithubIds: options.allowedGithubIds, security: { publicOrigin: options.publicOrigin } }) : authorizeOperator(session, options.allowedGithubIds);
  if (!access.authorized) return { status: access.status, body: operatorDenialBody(access.reason) };
  if (pathname === "/api/operator/runs" && request.method === "GET") return { status: 200, body: { runs: options.store.snapshot().runs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 100) } };
  if (pathname === "/api/operator/runs" && request.method === "POST") { const value = record(body); const parsed = typeof value.url === "string" ? normalizeRepoInput(value.url) : undefined; if (!parsed || typeof value.idempotencyKey !== "string") return { status: 422, body: { error: "url and idempotencyKey required" } }; const owner = parsed.owner.toLowerCase(); const repo = parsed.repo.toLowerCase(); const created = options.store.createRun({ idempotencyKey: value.idempotencyKey, source: { repositoryId: canonicalOperatorRepositoryId(`repo:${owner}/${repo}`), owner, repo, slug: parsed.dirSlug, ...(parsed.ref ? { ref: parsed.ref } : {}) } }); if (!created.deduped) await workflow.enqueue({ kind: "run", runId: created.run.runId, githubAccess: resolveScanGithubAccess({ session: access.session }) }); return { status: 202, body: created }; }
  const runMatch = /^\/api\/operator\/runs\/([^/]+)(?:\/cancel)?$/.exec(pathname); if (runMatch) { const detail = workflow.runDetail(decodeURIComponent(runMatch[1]!)); if (!detail) return { status: 404, body: { error: "not found" } }; if (pathname.endsWith("/cancel") && request.method === "POST") return { status: 200, body: { run: options.store.updateRun(detail.run.runId, { state: "cancelled" }) } }; if (request.method === "GET") return { status: 200, body: detail }; }
  const draft = /^\/api\/operator\/drafts\/([^/]+)(?:\/(bundle|retry|refresh|publish|claim-checks))?$/.exec(pathname); if (!draft) return { status: 404, body: { error: "not found" } }; const id = decodeURIComponent(draft[1]!); const detail = workflow.draftDetail(id); if (!detail) return { status: 404, body: { error: "not found" } }; const action = draft[2]; if (!action && request.method === "GET") return { status: 200, body: detail }; if (action === "bundle" && request.method === "GET") return { status: 200, body: { bundle: workflow.bundle(id)?.toString("utf8") } }; const value = record(body); if ((action === "retry" || action === "refresh") && request.method === "POST") { const currentRun = options.store.snapshot().runs.find(run => run.runId === detail.draft.runId); if (currentRun?.state === "queued" || currentRun?.state === "running") return { status: 409, body: { error: "operator action already running", code: "run_active" } }; const currentDraftRevisionId = currentRun?.draftRevisionId; if (currentDraftRevisionId !== id) return { status: 409, body: { error: "draft is no longer current", code: "draft_superseded", ...(currentDraftRevisionId ? { currentDraftRevisionId } : {}) } }; let scopeIds: string[]; let batch = false; if (action === "retry") { const parsed = parseRetrySelection(value, detail.scopes); if ("error" in parsed) return { status: 422, body: { error: parsed.error } }; scopeIds = parsed.scopeIds; batch = parsed.batch; } else { scopeIds = Array.isArray(value.scopeIds) ? value.scopeIds.filter((v): v is string => typeof v === "string") : []; if (!scopeIds.length || scopeIds.some(scopeId => !detail.scopes.some(scope => scope.scopeId === scopeId))) return { status: 422, body: { error: "known scope id required" } }; } /* Refresh is one batch pass too (CLA-264): stale scopes and their shared ancestors re-reduce once. */ await workflow.enqueue({ kind: action, runId: detail.draft.runId, draftRevisionId: id, scopeIds, ...(batch || action === "refresh" ? { batch: true } : {}), githubAccess: resolveScanGithubAccess({ session: access.session }) }); return { status: 202, body: { run: detail.draft.runId, draftRevisionId: id } }; }
  if (action === "claim-checks" && request.method === "POST") {
    // Same guards as retry: mutation auth above, no active pass, and only the run's current revision.
    const currentRun = options.store.snapshot().runs.find(run => run.runId === detail.draft.runId);
    if (currentRun?.state === "queued" || currentRun?.state === "running") return { status: 409, body: { error: "operator action already running", code: "run_active" } };
    if (currentRun?.draftRevisionId !== id) return { status: 409, body: { error: "draft is no longer current", code: "draft_superseded", ...(currentRun?.draftRevisionId ? { currentDraftRevisionId: currentRun.draftRevisionId } : {}) } };
    if (currentRun.state !== "awaiting_review" && currentRun.state !== "complete") return { status: 409, body: { error: "run is not reviewable", code: "run_not_reviewable" } };
    if (!resolveClaimCheckConfig().enabled) return { status: 422, body: { error: "Claim checks are off on this server (OKIE_JEV_CLAIM_CHECKS).", code: "claim_checks_disabled" } };
    const parsed = parseClaimCheckSelection(value, detail.scopes);
    if ("error" in parsed) return { status: 422, body: { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) } };
    await workflow.enqueue({ kind: "claim-checks", runId: detail.draft.runId, draftRevisionId: id, scopeIds: parsed.scopeIds, githubAccess: resolveScanGithubAccess({ session: access.session }) });
    return { status: 202, body: { run: detail.draft.runId, draftRevisionId: id, scopes: parsed.scopeIds.length } };
  }
  if (action === "publish" && request.method === "POST") {
    const required = ["atlas.okie.json", "snapshot.json", "view.json", "scene.json", "story.json", "stories.json", "timeline.json"];
    const artifact = options.store.snapshot().artifacts.find(item => item.artifactRevisionId === detail.draft.artifactRevisionId);
    const bundle = options.store.readArtifactFile(detail.draft.artifactRevisionId, "atlas.okie.json");
    try {
      if (!artifact || required.some(file => !artifact.files.includes(file)) || !bundle) throw new Error("missing public artifact");
      const portable = parsePortableAtlas(bundle.toString("utf8"));
      const original = JSON.parse(bundle.toString("utf8")) as { snapshot: unknown; view: unknown; story: unknown };
      const repository = portable.repository.url ? normalizeRepoInput(portable.repository.url) : undefined;
      if (!repository || repository.owner.toLowerCase() !== detail.source.owner.toLowerCase() ||
          repository.repo.toLowerCase() !== detail.source.repo.toLowerCase() ||
          artifact.sourceCommitSha !== portable.repository.commitSha ||
          (detail.source.commitSha && detail.source.commitSha !== portable.repository.commitSha)) throw new Error("artifact source mismatch");
      const read = (name: string): unknown => JSON.parse(options.store.readArtifactFile(artifact.artifactRevisionId, name)!.toString("utf8"));
      // Semantic repository IDs are scanner-owned, distinct from the operator's
      // owner/repo key. Compare the actual immutable contents instead.
      if (!isDeepStrictEqual(read("snapshot.json"), original.snapshot) ||
          !isDeepStrictEqual(read("view.json"), original.view) ||
          !isDeepStrictEqual(read("story.json"), original.story)) throw new Error("mixed public artifacts");
      for (const name of ["scene.json", "stories.json", "timeline.json"]) read(name);
    } catch { return { status: 422, body: { error: "draft artifact is not publishable" } }; }
    const result = options.publications.publishDraft({ repositoryId: detail.draft.repositoryId, draftRevisionId: id, ...(typeof value.expectedCurrentVersionId === "string" ? { expectedCurrentVersionId: value.expectedCurrentVersionId } : {}), acknowledgeCoverage: value.acknowledgeCoverage === true, coverage: detail.draft.coverage }); return result.ok ? { status: 200, body: result } : result.reason === "stale_publication" ? { status: 409, body: { ...result, code: "publication_stale" } } : { status: 422, body: result };
  }
  return { status: 404, body: { error: "not found" } };
}
