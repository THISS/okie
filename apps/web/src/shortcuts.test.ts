import { describe, expect, it } from 'vitest';
import { shouldOpenAskAtlas } from './shortcuts';

const baseEvent = { key: 'Enter', metaKey: true, ctrlKey: false, repeat: false, target: null };

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
