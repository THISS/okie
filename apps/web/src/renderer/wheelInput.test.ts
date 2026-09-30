import { describe, expect, it, vi } from 'vitest';
import { listenForGesturePinch, listenForWheel } from './wheelInput';

describe('native wheel input', () => {
  it('prevents native scrolling without a passive-listener console warning', () => {
    const target = new EventTarget();
    const onWheel = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detach = listenForWheel(target, onWheel);
    const event = new Event('wheel', { cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onWheel).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
    detach();
    target.dispatchEvent(new Event('wheel', { cancelable: true }));
    expect(onWheel).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('forwards Safari gesture pinch scale and position, preventing page zoom, until detached', () => {
    const target = new EventTarget();
    const onStart = vi.fn();
    const onChange = vi.fn();
    const onEnd = vi.fn();
    const detach = listenForGesturePinch(target, { onStart, onChange, onEnd });
    const gesture = (type: string, scale: number) => Object.assign(new Event(type, { cancelable: true }), { scale, clientX: 120, clientY: 80 });
    const start = gesture('gesturestart', 1);
    const change = gesture('gesturechange', 1.5);
    target.dispatchEvent(start);
    target.dispatchEvent(change);
    target.dispatchEvent(gesture('gestureend', 1.5));
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ scale: 1, clientX: 120, clientY: 80 }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.5, clientX: 120, clientY: 80 }));
    expect(onEnd).toHaveBeenCalledOnce();
    target.dispatchEvent(gesture('gesturechange', 0));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 1 }));
    detach();
    target.dispatchEvent(gesture('gesturechange', 2));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
