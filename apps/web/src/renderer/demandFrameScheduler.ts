export type DemandFrameScheduler = {
  wake(): void;
  animateUntil(deadlineMs: number): void;
  setContinuous(continuous: boolean): void;
  dispose(): void;
  isScheduled(): boolean;
};

type FrameApi = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
};

export function createDemandFrameScheduler(
  render: FrameRequestCallback,
  frameApi: FrameApi = {
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: handle => cancelAnimationFrame(handle),
  },
): DemandFrameScheduler {
  let frame: number | undefined;
  let continuous = false;
  let transientDeadline = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const wake = () => {
    if (disposed || frame !== undefined) return;
    frame = frameApi.requestFrame(time => {
      frame = undefined;
      if (disposed) return;
      render(time);
      if (continuous || time < transientDeadline) wake();
      else transientDeadline = Number.NEGATIVE_INFINITY;
    });
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
      if (frame !== undefined) frameApi.cancelFrame(frame);
      frame = undefined;
    },
    isScheduled: () => frame !== undefined,
  };
}
