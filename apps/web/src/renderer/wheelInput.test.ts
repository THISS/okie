import { describe, expect, it, vi } from 'vitest';
import { listenForWheel } from './wheelInput';

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
});
