export function listenForWheel(target: EventTarget, onWheel: (event: WheelEvent) => void) {
  const handleWheel = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    onWheel(event as WheelEvent);
  };
  target.addEventListener('wheel', handleWheel, { passive: false });
  return () => target.removeEventListener('wheel', handleWheel);
}
