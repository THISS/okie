import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ScanGithubAccess } from "./githubAccess.js";
import { startIncrementalRun, validIncrementalRef, type IncrementalStartContext, type IncrementalStartResult } from "./operatorIncremental.js";
import type { OperatorPublicationService } from "./operatorPublication.js";
import { canonicalOperatorRepositoryId, type OperatorStore } from "./operatorStore.js";

/**
 * CLA-271 triggers that run without a browser session. Both are off unless configured:
 * - cron: POST /api/operator/cron/incremental with `Authorization: Bearer $OKIE_INCREMENTAL_CRON_TOKEN` (constant-time compare);
 * - GitHub push webhook: POST /api/operator/webhooks/github, `X-Hub-Signature-256` HMAC-SHA256 over the raw body with
 *   `OKIE_GITHUB_WEBHOOK_SECRET` (constant-time compare), default-branch pushes only, deduplicated on `X-GitHub-Delivery`,
 *   debounced per repository; the push only triggers a start that resolves default-branch HEAD at fire time.
 * Without their secret each route answers 404, as if it did not exist.
 */
export const INCREMENTAL_WEBHOOK_PATH = "/api/operator/webhooks/github";
export const INCREMENTAL_CRON_PATH = "/api/operator/cron/incremental";
export const DEFAULT_INCREMENTAL_DEBOUNCE_MS = 60_000;
/** GitHub caps webhook payloads at 25 MB; a push payload is far smaller. */
export const WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;
const UNAUTHENTICATED: ScanGithubAccess = { kind: "unauthenticated" };

export interface IncrementalTriggerConfig { cronToken?: string; webhookSecret?: string; debounceMs: number; autoPublish: boolean }
export function resolveIncrementalTriggerConfig(env: NodeJS.ProcessEnv = process.env): IncrementalTriggerConfig {
  const debounce = Number.parseInt(env.OKIE_INCREMENTAL_DEBOUNCE_MS ?? "", 10);
  const secret = (name: string) => { const value = env[name]?.trim(); return value ? value : undefined; };
  const cronToken = secret("OKIE_INCREMENTAL_CRON_TOKEN"); const webhookSecret = secret("OKIE_GITHUB_WEBHOOK_SECRET");
  return { ...(cronToken ? { cronToken } : {}), ...(webhookSecret ? { webhookSecret } : {}), debounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : DEFAULT_INCREMENTAL_DEBOUNCE_MS, autoPublish: env.OKIE_INCREMENTAL_AUTO_PUBLISH === "1" };
}

/** `X-Hub-Signature-256` check: `sha256=<hex HMAC of the raw body>`, compared in constant time. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: unknown): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
/** Bearer token check; both sides are hashed first so the comparison is constant-time whatever their lengths. */
export function bearerMatches(expected: string, header: unknown): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length).trim()), digest(expected));
}

export interface IncrementalTimer { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimer: IncrementalTimer = { set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; }, clear: handle => clearTimeout(handle as NodeJS.Timeout) };

/**
 * Per-repository debounce. A push is only a trigger: a burst coalesces into one start once the repository has been quiet
 * for `debounceMs`, and the start resolves the default branch's HEAD at fire time (never the pushed SHA), so an
 * out-of-order or redelivered older push can never move a draft backwards. A push that lands while a run is active keeps
 * exactly one pending follow-up, retried every `debounceMs` until the active run ends.
 */
export function createIncrementalScheduler(options: { debounceMs: number; timer?: IncrementalTimer; start(repositoryId: string): Promise<IncrementalStartResult> }) {
  const timer = options.timer ?? realTimer;
  /** Per repository: a generation counter bumped by every push; a fire only clears the generation it started from. */
  const pending = new Map<string, number>(); const timers = new Map<string, unknown>(); let generation = 0;
  const arm = (repositoryId: string) => {
    const previous = timers.get(repositoryId); if (previous !== undefined) timer.clear(previous);
    timers.set(repositoryId, timer.set(() => { void fire(repositoryId); }, options.debounceMs));
  };
  const fire = async (repositoryId: string) => {
    timers.delete(repositoryId);
    const started = pending.get(repositoryId); if (started === undefined) return;
    let result: IncrementalStartResult | undefined;
    try { result = await options.start(repositoryId); } catch { result = undefined; }
    // A newer push may have re-armed while this start was awaiting; it owns the follow-up.
    if (pending.get(repositoryId) !== started) return;
    if (result?.status === "active") { arm(repositoryId); return; }
    pending.delete(repositoryId);
  };
  return {
    schedule(repositoryId: string) { generation += 1; pending.set(repositoryId, generation); arm(repositoryId); },
    pending(repositoryId: string): boolean { return pending.has(repositoryId); },
  };
}
/** Bounded most-recently-seen set (insertion-ordered Map): remembers the last `limit` keys. */
export function createDeliveryLru(limit = 512) {
  const seen = new Map<string, true>();
  return {
    /** True when `key` was already seen (and refreshes it); otherwise records it and returns false. */
    seen(key: string): boolean {
      if (seen.has(key)) { seen.delete(key); seen.set(key, true); return true; }
      seen.set(key, true); if (seen.size > limit) seen.delete(seen.keys().next().value!);
      return false;
    },
    get size() { return seen.size; },
  };
}
export type IncrementalScheduler = ReturnType<typeof createIncrementalScheduler>;

export interface IncrementalAutomationOptions {
  config: IncrementalTriggerConfig;
  store: OperatorStore;
  publications: OperatorPublicationService;
  enqueue: IncrementalStartContext["enqueue"];
  timer?: IncrementalTimer;
}
export interface IncrementalAutomation { config: IncrementalTriggerConfig; context: IncrementalStartContext; scheduler: IncrementalScheduler; deliveries: ReturnType<typeof createDeliveryLru> }
export function createIncrementalAutomation(options: IncrementalAutomationOptions): IncrementalAutomation {
  const context: IncrementalStartContext = { store: options.store, publications: options.publications, enqueue: options.enqueue };
  const scheduler = createIncrementalScheduler({ debounceMs: options.config.debounceMs, ...(options.timer ? { timer: options.timer } : {}), start: async repositoryId => {
    try {
      const result = await startIncrementalRun(context, { repositoryId, trigger: "webhook", githubAccess: UNAUTHENTICATED, autoPublish: options.config.autoPublish });
      recordWebhookFire(options.store, repositoryId, result.status === "started" ? { status: "started", runId: result.runId } : result.status === "active" ? { status: "active", activeRunId: result.runId } : result.status === "up_to_date" ? { status: "up_to_date", commitSha: result.commitSha } : { status: result.status });
      return result;
    } catch (error) {
      console.error(`[okie] webhook incremental start failed for ${repositoryId}:`, error);
      recordWebhookFire(options.store, repositoryId, { status: "failed", reason: "could not start the incremental run" });
      throw error;
    }
  } });
  return { config: options.config, context, scheduler, deliveries: createDeliveryLru() };
}

/**
 * A debounced webhook start leaves a trace: an `incremental.webhook_fire` event on the repository's newest run (the new
 * run itself when one started), or a server log line when the repository has no run.
 */
function recordWebhookFire(store: OperatorStore, repositoryId: string, detail: Record<string, string>): void {
  try {
    const latest = store.snapshot().runs.filter(run => canonicalOperatorRepositoryId(run.source.repositoryId) === repositoryId).sort((left, right) => right.createdAt - left.createdAt)[0];
    if (latest) store.appendEvent({ runId: detail.runId ?? latest.runId, type: "incremental.webhook_fire", detail });
    else console.log(`[okie] webhook incremental start for ${repositoryId}: ${detail.status}`);
  } catch (error) { console.error(`[okie] could not record the webhook start for ${repositoryId}:`, error); }
}
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const header = (request: IncomingMessage, name: string) => { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; };
const knownRepository = (store: OperatorStore, repositoryId: string) => store.snapshot().runs.some(run => canonicalOperatorRepositoryId(run.source.repositoryId) === repositoryId);
function statusFor(result: IncrementalStartResult): number { return result.status === "started" ? 202 : result.status === "active" ? 409 : result.status === "no_baseline" ? 422 : 200; }

const NOT_FOUND = { status: 404, body: { error: "not found" } };
/**
 * Everything decidable before the body is read: the path (undefined = not an automation route), the method, whether the
 * route is configured (404 otherwise), the cron bearer token (401) and a declared Content-Length over the route's cap (413).
 * The server calls this first so an unconfigured or unauthorised request is never read.
 */
export function automationPreflight(automation: IncrementalAutomation | undefined, request: IncomingMessage, pathname: string): { status: number; body: unknown } | "read" | undefined {
  if (pathname !== INCREMENTAL_WEBHOOK_PATH && pathname !== INCREMENTAL_CRON_PATH) return undefined;
  if (request.method !== "POST" || !automation) return NOT_FOUND;
  const cron = pathname === INCREMENTAL_CRON_PATH;
  if (cron ? !automation.config.cronToken : !automation.config.webhookSecret) return NOT_FOUND;
  if (cron && !bearerMatches(automation.config.cronToken!, header(request, "authorization"))) return { status: 401, body: { error: "invalid cron token", code: "cron_unauthorized" } };
  const declared = Number(header(request, "content-length"));
  if (Number.isFinite(declared) && declared > automationBodyLimit(pathname)) return { status: 413, body: { error: "request body too large" } };
  return "read";
}
export const CRON_MAX_BODY_BYTES = 16 * 1024;
export function automationBodyLimit(pathname: string): number { return pathname === INCREMENTAL_WEBHOOK_PATH ? WEBHOOK_MAX_BODY_BYTES : CRON_MAX_BODY_BYTES; }

/**
 * Cron and webhook routes; `undefined` for any other path. Never touches the session or CSRF checks: each route has its
 * own secret. Auto-publish here follows only the server's OKIE_INCREMENTAL_AUTO_PUBLISH; a body `autoPublish` is ignored
 * (the per-request opt-in exists only on the session-authenticated operator route).
 */
export async function handleIncrementalAutomation(automation: IncrementalAutomation | undefined, request: IncomingMessage, pathname: string, rawBody: Buffer): Promise<{ status: number; body: unknown } | undefined> {
  const preflight = automationPreflight(automation, request, pathname);
  if (preflight !== "read") return preflight;
  const { config, context } = automation!;
  if (pathname === INCREMENTAL_CRON_PATH) {
    let body: Record<string, unknown> = {};
    try { body = rawBody.length ? record(JSON.parse(rawBody.toString("utf8"))) : {}; } catch { return { status: 400, body: { error: "Expected JSON body" } }; }
    if (body.ref !== undefined && (!validIncrementalRef(body.ref) || typeof body.repositoryId !== "string")) return { status: 422, body: { error: "ref needs a repositoryId and must be a branch, tag or SHA" } };
    const autoPublish = config.autoPublish;
    const repositories = typeof body.repositoryId === "string" ? [canonicalOperatorRepositoryId(body.repositoryId)]
      : [...new Set(context.store.snapshot().runs.map(run => canonicalOperatorRepositoryId(run.source.repositoryId)))].filter(repositoryId => context.publications.currentPublication(repositoryId)).sort();
    const results: Array<{ repositoryId: string } & (IncrementalStartResult | { status: "error"; error: string })> = [];
    for (const repositoryId of repositories) {
      if (!knownRepository(context.store, repositoryId)) { results.push({ repositoryId, status: "no_baseline" }); continue; }
      try { results.push({ repositoryId, ...await startIncrementalRun(context, { repositoryId, ...(typeof body.ref === "string" ? { ref: body.ref } : {}), trigger: "cron", githubAccess: UNAUTHENTICATED, autoPublish }) }); }
      catch (error) {
        // The detail stays in the server log; the response carries only a generic, stable message per repository.
        console.error(`[okie] cron incremental start failed for ${repositoryId}:`, error);
        results.push({ repositoryId, status: "error", error: "could not start the incremental run" });
      }
    }
    return { status: 200, body: { results } };
  }
  if (!verifyGithubSignature(config.webhookSecret!, rawBody, header(request, "x-hub-signature-256"))) return { status: 401, body: { error: "invalid signature", code: "signature_invalid" } };
  // GitHub redelivers with the same X-GitHub-Delivery id; only signed deliveries are remembered (bounded LRU).
  const delivery = header(request, "x-github-delivery");
  if (typeof delivery === "string" && delivery && automation!.deliveries.seen(delivery.slice(0, 100))) return { status: 200, body: { ignored: "duplicate_delivery" } };
  const event = header(request, "x-github-event");
  if (event !== "push") return { status: 200, body: { ignored: "event", event: typeof event === "string" ? event.slice(0, 40) : null } };
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(rawBody.toString("utf8"))); } catch { return { status: 400, body: { error: "Expected JSON body" } }; }
  const repository = record(payload.repository);
  const fullName = typeof repository.full_name === "string" ? repository.full_name : undefined;
  const defaultBranch = typeof repository.default_branch === "string" ? repository.default_branch : undefined;
  if (!fullName || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName) || !defaultBranch) return { status: 422, body: { error: "push payload needs repository.full_name and repository.default_branch" } };
  if (payload.ref !== `refs/heads/${defaultBranch}`) return { status: 200, body: { ignored: "branch" } };
  const after = typeof payload.after === "string" ? payload.after : "";
  if (!/^[0-9a-f]{40}$/.test(after) || /^0+$/.test(after)) return { status: 200, body: { ignored: "commit" } };
  const repositoryId = canonicalOperatorRepositoryId(`repo:${fullName}`);
  if (!knownRepository(context.store, repositoryId)) return { status: 200, body: { ignored: "repository" } };
  // The pushed SHA is only a trigger: the start resolves the default branch HEAD when the debounce fires.
  automation!.scheduler.schedule(repositoryId);
  return { status: 202, body: { scheduled: true, repositoryId, pushedCommitSha: after, debounceMs: config.debounceMs } };
}

/** Response for the session-guarded operator route (and the cron results): stable status codes. */
export function incrementalRouteResult(result: IncrementalStartResult): { status: number; body: unknown } {
  const body = result.status === "active" ? { ...result, error: "operator action already running", code: "run_active" } : result.status === "no_baseline" ? { ...result, error: "repository has no draft or publication to update", code: "no_baseline" } : result;
  return { status: statusFor(result), body };
}
