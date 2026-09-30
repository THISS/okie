export function listenForWheel(target: EventTarget, onWheel: (event: WheelEvent) => void) {
  const handleWheel = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    onWheel(event as WheelEvent);
  };
  target.addEventListener('wheel', handleWheel, { passive: false });
  return () => target.removeEventListener('wheel', handleWheel);
}

/** Safari's non-standard GestureEvent (trackpad pinch); `scale` is cumulative since gesturestart. */
export type GesturePinchSample = { scale: number; clientX: number; clientY: number; timeStamp: number };

export type GesturePinchHandlers = {
  onStart?: (sample: GesturePinchSample) => void;
  onChange: (sample: GesturePinchSample) => void;
  onEnd?: (sample: GesturePinchSample) => void;
};

/**
 * Safari (macOS) reports trackpad pinch as gesturestart/gesturechange/gestureend
 * rather than ctrlKey wheels. The listeners are non-passive and prevent the
 * default so the page itself does not zoom.
 */
export function listenForGesturePinch(target: EventTarget, handlers: GesturePinchHandlers) {
  const read = (event: Event): GesturePinchSample => {
    const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
    return {
      scale: typeof gesture.scale === 'number' && Number.isFinite(gesture.scale) && gesture.scale > 0 ? gesture.scale : 1,
      clientX: gesture.clientX ?? 0,
      clientY: gesture.clientY ?? 0,
      timeStamp: event.timeStamp,
    };
  };
  const wrap = (handler: ((sample: GesturePinchSample) => void) | undefined) => (event: Event) => {
    if (event.cancelable) event.preventDefault();
    handler?.(read(event));
  };
  const listeners: [string, (event: Event) => void][] = [
    ['gesturestart', wrap(handlers.onStart)],
    ['gesturechange', wrap(handlers.onChange)],
    ['gestureend', wrap(handlers.onEnd)],
  ];
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { passive: false });
  return () => {
    for (const [type, listener] of listeners) target.removeEventListener(type, listener);
  };
}
