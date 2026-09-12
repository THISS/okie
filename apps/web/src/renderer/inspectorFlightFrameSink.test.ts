import { describe, expect, it, vi } from 'vitest';
import { createInspectorFlightFrameSink } from './inspectorFlightFrameSink';

describe('inspector flight frame sink', () => {
  it('cancels queued gesture writers before they can overwrite a flight frame', () => {
    vi.useFakeTimers();
    const live = { x: 20, y: 40, zoom: 2 };
    const stale = { x: -10, y: -20, zoom: .5 };
    const flight = { x: 90, y: 80, zoom: 4 };
    let painted = { ...live };
    let raw = { ...stale };
    let pendingRawAdoption: typeof stale | undefined = stale;
    const scheduleWriter = () => setTimeout(() => { painted = { ...stale }; }, 10);
    const publisher = scheduleWriter();
    const wheelSettle = scheduleWriter();
    const assist = scheduleWriter();
    const glide = scheduleWriter();
    const panSettle = scheduleWriter();
    const pinchSettle = scheduleWriter();
    const sink = createInspectorFlightFrameSink({
      readLiveCamera: () => live,
      cancelPublishedCamera: () => clearTimeout(publisher),
      cancelSemanticZoomSettle: () => clearTimeout(wheelSettle),
      cancelSemanticAssist: () => clearTimeout(assist),
      cancelSettleGlide: () => clearTimeout(glide),
      cancelGestureSettles: () => { clearTimeout(panSettle); clearTimeout(pinchSettle); },
      clearPendingRawAdoption: () => { pendingRawAdoption = undefined; },
      rebaseRawCamera: camera => { raw = { ...camera }; },
      applyFrame: camera => { painted = { ...camera }; },
    });

    try {
      const source = sink.begin();
      sink.render(flight);
      vi.advanceTimersByTime(20);

      expect(source).toEqual(live);
      expect(source).not.toBe(live);
      expect(painted).toEqual(flight);
      expect(raw).toEqual(live);
      expect(pendingRawAdoption).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders flight frames without invoking any publisher or cancellation callback', () => {
    const applyFrame = vi.fn();
    const cancelPublishedCamera = vi.fn();
    const sink = createInspectorFlightFrameSink({
      readLiveCamera: () => ({ x: 0, y: 0, zoom: 1 }),
      cancelPublishedCamera,
      cancelSemanticZoomSettle: vi.fn(),
      cancelSemanticAssist: vi.fn(),
      cancelSettleGlide: vi.fn(),
      cancelGestureSettles: vi.fn(),
      clearPendingRawAdoption: vi.fn(),
      rebaseRawCamera: vi.fn(),
      applyFrame,
    });
    const frame = { x: 3, y: 4, zoom: 5 };

    sink.render(frame);

    expect(applyFrame).toHaveBeenCalledWith(frame);
    expect(cancelPublishedCamera).not.toHaveBeenCalled();
  });
});
