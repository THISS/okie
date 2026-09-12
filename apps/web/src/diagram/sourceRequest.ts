/** Async publication guard shared by SourceViewer and deterministic race tests.
 * select runs during render; cancel is also called by the effect cleanup.
 */
export function createSourceRequestController() {
  let selectedIdentity: string | undefined;
  let current: AbortController | undefined;
  let requestIdentity: string | undefined;
  return {
    select(identity: string) { selectedIdentity = identity; },
    isPending(identity: string) { return selectedIdentity === identity && requestIdentity === identity && Boolean(current && !current.signal.aborted); },
    cancel() { current?.abort(); current = undefined; },
    async run<T>(identity: string, request: (signal: AbortSignal) => Promise<T>, publish: (value: T) => void, fail: (error: unknown) => void) {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      requestIdentity = identity;
      const active = () => selectedIdentity === identity && current === controller && !controller.signal.aborted;
      try {
        const value = await request(controller.signal);
        if (active()) publish(value);
      } catch (error) {
        if (active()) fail(error);
      } finally {
        if (current === controller) current = undefined;
      }
    },
  };
}

/** The actual SourceViewer loading predicate: a remembered state is not a pending request. */
export function sourceContextIsLoading(controller: ReturnType<typeof createSourceRequestController>, identity: string, state?: { identity: string; loading?: boolean }): boolean {
  return state?.identity === identity && state.loading === true && controller.isPending(identity);
}
