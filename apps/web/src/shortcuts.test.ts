import { describe, expect, it } from 'vitest';
import { shouldOpenAskAtlas, shouldToggleDevMode } from './shortcuts';

const baseEvent = { key: 'Enter', metaKey: true, ctrlKey: false, repeat: false, target: null };

const devModeEvent = { code: 'KeyD', altKey: true, shiftKey: true, metaKey: false, ctrlKey: false, repeat: false };

describe('shouldOpenAskAtlas', () => {
  it('accepts Cmd/Ctrl+Enter from the canvas surface', () => {
    expect(shouldOpenAskAtlas(baseEvent, false)).toBe(true);
    expect(shouldOpenAskAtlas({ ...baseEvent, metaKey: false, ctrlKey: true }, false)).toBe(true);
  });

  it('does not intercept form controls or a repeated keydown', () => {
    const textarea = { closest: () => ({ tagName: 'TEXTAREA' }) } as unknown as EventTarget;
    expect(shouldOpenAskAtlas({ ...baseEvent, target: textarea }, false)).toBe(false);
    expect(shouldOpenAskAtlas({ ...baseEvent, repeat: true }, false)).toBe(false);
  });

  it('does not replace an active guided story', () => {
    expect(shouldOpenAskAtlas(baseEvent, true)).toBe(false);
  });
});

describe('shouldToggleDevMode', () => {
  it('accepts Shift+Alt+D via the physical KeyD code', () => {
    expect(shouldToggleDevMode(devModeEvent)).toBe(true);
  });

  it('requires both Alt and Shift and rejects Cmd/Ctrl variants', () => {
    expect(shouldToggleDevMode({ ...devModeEvent, altKey: false })).toBe(false);
    expect(shouldToggleDevMode({ ...devModeEvent, shiftKey: false })).toBe(false);
    expect(shouldToggleDevMode({ ...devModeEvent, metaKey: true })).toBe(false);
    expect(shouldToggleDevMode({ ...devModeEvent, ctrlKey: true })).toBe(false);
  });

  it('ignores other physical keys and auto-repeat', () => {
    expect(shouldToggleDevMode({ ...devModeEvent, code: 'KeyF' })).toBe(false);
    expect(shouldToggleDevMode({ ...devModeEvent, repeat: true })).toBe(false);
  });
});
