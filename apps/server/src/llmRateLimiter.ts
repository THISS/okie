import { classifyLlmGatewayFailure, type LlmChatCompletionResult, type LlmRateLimitConfig } from "./llmGateway.js";

export interface RateLimitedGateway { readonly modelId: string; chatCompletions(body: Record<string, unknown>): Promise<LlmChatCompletionResult>; }
export interface LlmRateLimiterOptions extends LlmRateLimitConfig { sleep?: (ms: number) => Promise<void>; now?: () => number; }

/**
 * One provider's admission gate: caps in-flight requests and, on a 429, pauses
 * every caller for that provider with exponential backoff before retrying.
 * Retries happen below the operator budget layer, so they never consume budget.
 */
export class LlmRateLimiter {
  private inFlight = 0;
  private pausedUntil = 0;
  private readonly waiters: Array<() => void> = [];
  private options: Required<LlmRateLimiterOptions>;
  constructor(options: LlmRateLimiterOptions) { this.options = { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now, ...options }; }
  configure(options: Partial<LlmRateLimitConfig>): void { this.options = { ...this.options, ...options }; for (const wake of this.waiters.splice(0)) wake(); }
  get active(): number { return this.inFlight; }
  private async acquire(): Promise<void> {
    for (;;) {
      const wait = this.pausedUntil - this.options.now();
      if (wait > 0) { await this.options.sleep(wait); continue; }
      if (this.inFlight < Math.max(1, this.options.maxConcurrent)) { this.inFlight += 1; return; }
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }
  private release(): void { this.inFlight -= 1; this.waiters.shift()?.(); }
  async run<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.acquire();
      try { return await work(); }
      catch (error) {
        if (classifyLlmGatewayFailure(error) !== "rate_limit" || attempt >= this.options.retries) throw error;
        this.pausedUntil = Math.max(this.pausedUntil, this.options.now() + this.options.backoffMs * 2 ** attempt);
      } finally { this.release(); }
    }
  }
}

const shared = new Map<string, LlmRateLimiter>();
/** Process-wide limiter per provider key (gateway hostname); later calls update caps. */
export function sharedLlmRateLimiter(provider: string, config: LlmRateLimitConfig): LlmRateLimiter {
  const existing = shared.get(provider);
  if (existing) { existing.configure(config); return existing; }
  const created = new LlmRateLimiter(config); shared.set(provider, created); return created;
}

export function rateLimitedGateway<G extends RateLimitedGateway>(gateway: G, limiter: LlmRateLimiter): RateLimitedGateway {
  return { modelId: gateway.modelId, chatCompletions: body => limiter.run(() => gateway.chatCompletions(body)) };
}
