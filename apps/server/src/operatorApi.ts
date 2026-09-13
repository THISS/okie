import type { IncomingMessage } from "node:http";
import { authorizeOperator, authorizeOperatorMutation, publicOperatorAccessView } from "./operatorAccess.js";
import type { GithubAuthService } from "./githubOAuth.js";
import { normalizeRepoInput } from "./repoUrl.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorWorkflow, type OperatorWorkflowJob } from "./operatorWorkflow.js";
import { resolveScanGithubAccess } from "./githubAccess.js";
import { parsePortableAtlas } from "@okie/architecture";

export interface OperatorApiOptions { auth: GithubAuthService; allowedGithubIds: ReadonlySet<string>; publicOrigin: string; store: OperatorStore; publications: OperatorPublicationService; enqueue: (job: OperatorWorkflowJob) => void | Promise<void>; }
export interface OperatorApiResult { status: number; body: unknown; }
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
/** Authorization happens before any ID lookup, intentionally preventing existence inference. */
export async function handleOperatorApi(options: OperatorApiOptions, request: IncomingMessage, pathname: string, body?: unknown): Promise<OperatorApiResult | undefined> {
  if (!pathname.startsWith("/api/operator")) return undefined;
  const session = options.auth.sessionFromRequest(request); const workflow = new OperatorWorkflow({ store: options.store, publications: options.publications, enqueue: options.enqueue });
  if (pathname === "/api/operator/session" && request.method === "GET") return { status: 200, body: publicOperatorAccessView(authorizeOperator(session, options.allowedGithubIds)) };
  const mutation = request.method === "POST"; const access = mutation ? authorizeOperatorMutation({ request, session, allowedGithubIds: options.allowedGithubIds, security: { publicOrigin: options.publicOrigin } }) : authorizeOperator(session, options.allowedGithubIds);
  if (!access.authorized) return { status: access.status, body: { error: "operator access required" } };
  if (pathname === "/api/operator/runs" && request.method === "GET") return { status: 200, body: { runs: options.store.snapshot().runs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 100) } };
  if (pathname === "/api/operator/runs" && request.method === "POST") { const value = record(body); const parsed = typeof value.url === "string" ? normalizeRepoInput(value.url) : undefined; if (!parsed || typeof value.idempotencyKey !== "string") return { status: 422, body: { error: "url and idempotencyKey required" } }; const created = options.store.createRun({ idempotencyKey: value.idempotencyKey, source: { repositoryId: `repo:${parsed.owner}/${parsed.repo}`, owner: parsed.owner, repo: parsed.repo, slug: parsed.dirSlug, ...(parsed.ref ? { ref: parsed.ref } : {}) } }); if (!created.deduped) await workflow.enqueue({ kind: "run", runId: created.run.runId, githubAccess: resolveScanGithubAccess({ session: access.session }) }); return { status: 202, body: created }; }
  const runMatch = /^\/api\/operator\/runs\/([^/]+)(?:\/cancel)?$/.exec(pathname); if (runMatch) { const detail = workflow.runDetail(decodeURIComponent(runMatch[1]!)); if (!detail) return { status: 404, body: { error: "not found" } }; if (pathname.endsWith("/cancel") && request.method === "POST") return { status: 200, body: { run: options.store.updateRun(detail.run.runId, { state: "cancelled" }) } }; if (request.method === "GET") return { status: 200, body: detail }; }
  const draft = /^\/api\/operator\/drafts\/([^/]+)(?:\/(bundle|retry|refresh|publish))?$/.exec(pathname); if (!draft) return { status: 404, body: { error: "not found" } }; const id = decodeURIComponent(draft[1]!); const detail = workflow.draftDetail(id); if (!detail) return { status: 404, body: { error: "not found" } }; const action = draft[2]; if (!action && request.method === "GET") return { status: 200, body: detail }; if (action === "bundle" && request.method === "GET") return { status: 200, body: { bundle: workflow.bundle(id)?.toString("utf8") } }; const value = record(body); if ((action === "retry" || action === "refresh") && request.method === "POST") { const scopeIds = action === "retry" && typeof value.scopeId === "string" ? [value.scopeId] : Array.isArray(value.scopeIds) ? value.scopeIds.filter((v): v is string => typeof v === "string") : []; if (!scopeIds.length || scopeIds.some(scopeId => !detail.scopes.some(scope => scope.scopeId === scopeId))) return { status: 422, body: { error: "known scope id required" } }; await workflow.enqueue({ kind: action, runId: detail.draft.runId, draftRevisionId: id, scopeIds, githubAccess: resolveScanGithubAccess({ session: access.session }) }); return { status: 202, body: { run: detail.draft.runId, draftRevisionId: id } }; }
  if (action === "publish" && request.method === "POST") {
    const required = ["atlas.okie.json", "snapshot.json", "view.json", "scene.json", "story.json", "stories.json", "timeline.json"];
    const artifact = options.store.snapshot().artifacts.find(item => item.artifactRevisionId === detail.draft.artifactRevisionId);
    const bundle = options.store.readArtifactFile(detail.draft.artifactRevisionId, "atlas.okie.json");
    try {
      if (!artifact || required.some(file => !artifact.files.includes(file)) || !bundle) throw new Error("missing public artifact");
      parsePortableAtlas(bundle.toString("utf8"));
      const snapshot = JSON.parse(options.store.readArtifactFile(detail.draft.artifactRevisionId, "snapshot.json")!.toString("utf8")) as { repositoryId?: string; commitSha?: string };
      if (snapshot.repositoryId !== detail.source.repositoryId || (detail.source.commitSha && snapshot.commitSha !== detail.source.commitSha)) throw new Error("artifact source mismatch");
    } catch { return { status: 422, body: { error: "draft artifact is not publishable" } }; }
    const result = options.publications.publishDraft({ repositoryId: detail.draft.repositoryId, draftRevisionId: id, ...(typeof value.expectedCurrentVersionId === "string" ? { expectedCurrentVersionId: value.expectedCurrentVersionId } : {}), acknowledgeCoverage: value.acknowledgeCoverage === true }); return result.ok ? { status: 200, body: result } : { status: result.reason === "stale_publication" ? 409 : 422, body: result };
  }
  return { status: 404, body: { error: "not found" } };
}
