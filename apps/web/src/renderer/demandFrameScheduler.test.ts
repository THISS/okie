import { describe, expect, it, vi } from 'vitest';
import { createDemandFrameScheduler } from './demandFrameScheduler';

function frameHarness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  return {
    api: {
      requestFrame(callback: FrameRequestCallback) {
        id += 1;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame(handle: number) { callbacks.delete(handle); },
    },
    step(time = 16) {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach(callback => callback(time));
    },
    queued: () => callbacks.size,
  };
}

describe('demand frame scheduler', () => {
  it('coalesces wakes into one frame and sleeps after rendering', () => {
    const harness = frameHarness();
    const render = vi.fn();
    const scheduler = createDemandFrameScheduler(render, harness.api);
    scheduler.wake();
    scheduler.wake();
    expect(harness.queued()).toBe(1);
    harness.step();
    expect(render).toHaveBeenCalledOnce();
    expect(harness.queued()).toBe(0);
  });

  it('stays awake only while animation is active', () => {
    const harness = frameHarness();
    const render = vi.fn();
    const scheduler = createDemandFrameScheduler(render, harness.api);
    scheduler.setContinuous(true);
    harness.step();
    expect(render).toHaveBeenCalledOnce();
    expect(harness.queued()).toBe(1);
    scheduler.setContinuous(false);
    harness.step();
    expect(render).toHaveBeenCalledTimes(2);
    expect(harness.queued()).toBe(0);
  });

  it('runs a bounded semantic-zoom handoff and returns to idle', () => {
    const harness = frameHarness();
    const render = vi.fn();
    const scheduler = createDemandFrameScheduler(render, harness.api);
    scheduler.animateUntil(200);
    harness.step(0);
    expect(harness.queued()).toBe(1);
    harness.step(100);
    expect(harness.queued()).toBe(1);
    harness.step(200);
    expect(harness.queued()).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
  });

  it('sleeps under reduced motion when continuous animation is disabled', () => {
    const harness = frameHarness();
    const render = vi.fn();
    const scheduler = createDemandFrameScheduler(render, harness.api);
    const reduceMotion = true;
    scheduler.setContinuous(!reduceMotion);
    scheduler.wake();
    harness.step();
    expect(render).toHaveBeenCalledOnce();
    expect(harness.queued()).toBe(0);
  });

  it('cancels queued work and cannot be woken after disposal', () => {
    const harness = frameHarness();
    const render = vi.fn();
    const scheduler = createDemandFrameScheduler(render, harness.api);
    scheduler.wake();
    scheduler.dispose();
    scheduler.wake();
    expect(harness.queued()).toBe(0);
    harness.step();
    expect(render).not.toHaveBeenCalled();
  });

  it('kicks a frame from the idle timeout when rAF is starved', () => {
    const render = vi.fn();
    const timeouts = new Map<number, () => void>();
    let timeoutId = 0;
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const scheduler = createDemandFrameScheduler(render, {
      requestFrame(callback) {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
      },
      cancelFrame(handle) { frames.delete(handle); },
      requestIdleKick(callback) {
        timeoutId += 1;
        timeouts.set(timeoutId, callback);
        return timeoutId;
      },
      cancelIdleKick(handle) { timeouts.delete(handle); },
    });
    scheduler.wake();
    expect(frames.size).toBe(1);
    expect(timeouts.size).toBe(1);
    [...timeouts.values()][0]!();
    expect(render).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
  });
});
