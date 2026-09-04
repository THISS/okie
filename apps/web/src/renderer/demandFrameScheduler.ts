export type DemandFrameScheduler = {
  wake(): void;
  animateUntil(deadlineMs: number): void;
  setContinuous(continuous: boolean): void;
  dispose(): void;
  isScheduled(): boolean;
};

export type FrameApi = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  /** Optional timeout kick when rAF is starved (cross-origin iframes). */
  requestIdleKick?: (callback: () => void) => number;
  cancelIdleKick?: (handle: number) => void;
};

export function createDemandFrameScheduler(
  render: FrameRequestCallback,
  frameApi: FrameApi = {
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: handle => cancelAnimationFrame(handle),
  },
): DemandFrameScheduler {
  let frame: number | undefined;
  let idle: number | undefined;
  let continuous = false;
  let transientDeadline = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const clearIdle = () => {
    if (idle === undefined) return;
    frameApi.cancelIdleKick?.(idle);
    idle = undefined;
  };

  const clearFrame = () => {
    if (frame === undefined) return;
    frameApi.cancelFrame(frame);
    frame = undefined;
  };

  const run = (time: number) => {
    frame = undefined;
    clearIdle();
    if (disposed) return;
    render(time);
    if (continuous || time < transientDeadline) wake();
    else transientDeadline = Number.NEGATIVE_INFINITY;
  };

  const wake = () => {
    if (disposed || frame !== undefined || idle !== undefined) return;
    frame = frameApi.requestFrame(run);
    if (frameApi.requestIdleKick) {
      idle = frameApi.requestIdleKick(() => {
        idle = undefined;
        clearFrame();
        run(typeof performance !== 'undefined' ? performance.now() : 0);
      });
    }
  };

  return {
    wake,
    animateUntil(deadlineMs) {
      transientDeadline = Math.max(transientDeadline, deadlineMs);
      wake();
    },
    setContinuous(next) {
      continuous = next;
      if (continuous) wake();
    },
    dispose() {
      disposed = true;
      clearFrame();
      clearIdle();
    },
    isScheduled: () => frame !== undefined || idle !== undefined,
  };
}
