import { describe, expect, it } from 'vitest';
import { searchOwnsKeystrokes, shouldOpenAskAtlas, shouldOpenSearch, shouldToggleDevMode } from './shortcuts';

const baseEvent = { key: 'Enter', metaKey: true, ctrlKey: false, repeat: false, target: null };

function element(options: { id?: string; tagName?: string; ancestors?: readonly string[] }) {
  const selectors = new Set(options.ancestors ?? []);
  if (options.id) selectors.add(`#${options.id}`);
  const stub = {
    id: options.id ?? '',
    tagName: options.tagName ?? 'DIV',
    closest(selector: string) {
      return selector.split(',').some(part => selectors.has(part.trim())) ? stub : null;
    },
  };
  return stub as unknown as EventTarget;
}

const searchInput = element({ id: 'atlas-search', tagName: 'INPUT', ancestors: ['.search-popover'] });
const searchResult = element({ tagName: 'BUTTON', ancestors: ['.search-popover'] });
const canvas = element({ tagName: 'DIV' });
const searchChord = { key: 'k', metaKey: true, ctrlKey: false, repeat: false, target: null as EventTarget | null };

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

describe('shouldOpenSearch', () => {
  it('accepts Cmd/Ctrl+K from the canvas when search is closed', () => {
    expect(shouldOpenSearch({ ...searchChord, target: canvas })).toBe(true);
    expect(shouldOpenSearch({ ...searchChord, metaKey: false, ctrlKey: true, target: canvas })).toBe(true);
    expect(shouldOpenSearch({ ...searchChord, key: 'K', target: null })).toBe(true);
    expect(searchOwnsKeystrokes(canvas)).toBe(false);
  });

  it('does not re-fire Cmd/Ctrl+K while search is focused', () => {
    expect(shouldOpenSearch({ ...searchChord, target: searchInput })).toBe(false);
    expect(shouldOpenSearch({ ...searchChord, metaKey: false, ctrlKey: true, target: searchInput })).toBe(false);
    expect(shouldOpenSearch({ ...searchChord, target: searchResult })).toBe(false);
    expect(searchOwnsKeystrokes(searchInput)).toBe(true);
    expect(searchOwnsKeystrokes(searchResult)).toBe(true);
  });

  it('ignores other keys, missing modifiers, and auto-repeat', () => {
    expect(shouldOpenSearch({ ...searchChord, key: 'f', target: canvas })).toBe(false);
    expect(shouldOpenSearch({ ...searchChord, metaKey: false, ctrlKey: false, target: canvas })).toBe(false);
    expect(shouldOpenSearch({ ...searchChord, repeat: true, target: canvas })).toBe(false);
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
