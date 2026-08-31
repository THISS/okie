import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { askOwnsKeystrokes, askOverlayPresent, keystrokeOwnedByTextEntry, searchOwnsKeystrokes } from './shortcuts';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

/**
 * Keyboard events name the focused element as `target`, and the keystroke guard only reads `id`,
 * `tagName`, `isContentEditable` and `closest` — so a stub is a faithful stand-in and the whole
 * contract is testable without a DOM environment or a React mount.
 */
function element(options: { id?: string; tagName?: string; isContentEditable?: boolean; ancestors?: readonly string[] }) {
  const selectors = new Set(options.ancestors ?? []);
  if (options.id) selectors.add(`#${options.id}`);
  const stub = {
    id: options.id ?? '',
    tagName: options.tagName ?? 'DIV',
    isContentEditable: options.isContentEditable ?? false,
    closest(selector: string) {
      return selector.split(',').some(part => selectors.has(part.trim())) ? stub : null;
    },
  };
  return stub as unknown as EventTarget;
}

const askInput = element({ id: 'atlas-question', tagName: 'TEXTAREA', ancestors: ['.ask-popover'] });
const askSubmit = element({ tagName: 'BUTTON', ancestors: ['.ask-popover'] });
const searchInput = element({ id: 'atlas-search', tagName: 'INPUT', ancestors: ['.search-popover'] });
const canvas = element({ tagName: 'DIV' });
const body = element({ tagName: 'BODY' });

const shortcutBody = (() => {
  const start = app.indexOf('function shortcut(event: KeyboardEvent) {');
  const end = app.indexOf("window.addEventListener('keydown', shortcut)", start);
  if (start < 0 || end < 0) throw new Error('Missing the App window keydown handler');
  return app.slice(start, end);
})();

const canvasKeyHandler = (() => {
  const start = app.indexOf('onKeyDown={event => { if (searchOwnsKeystrokes(event.target)) return;');
  const end = app.indexOf('onPointerCancel=', start);
  if (start < 0 || end < 0) throw new Error('Missing the guarded CanvasViewport onKeyDown handler');
  return app.slice(start, end);
})();

const askInputMarkup = (() => {
  const line = app.split('\n').find(candidate => candidate.includes('id="atlas-question"'));
  if (!line) throw new Error('Missing the #atlas-question textarea');
  return line;
})();

function topLevelBranches(body: string) {
  const branches: string[] = [];
  let current: string[] | undefined;
  for (const line of body.split('\n')) {
    if (/^ {6}\S/.test(line)) {
      if (current) branches.push(current.join('\n'));
      current = /^ {6}if \(/.test(line) ? [line] : undefined;
      continue;
    }
    current?.push(line);
  }
  if (current) branches.push(current.join('\n'));
  return branches;
}

function escapeBranch() {
  const escape = topLevelBranches(shortcutBody).find(branch => branch.startsWith("      if (event.key === 'Escape')"));
  if (!escape) throw new Error('Missing the window Escape shortcut branch');
  return escape;
}

describe('Ask owns its Escape keystroke', () => {
  it('claims the Ask textarea, the popover controls around it, and nothing on the canvas', () => {
    expect(askOwnsKeystrokes(askInput)).toBe(true);
    expect(askOwnsKeystrokes(askSubmit)).toBe(true);
    expect(askOwnsKeystrokes(searchInput)).toBe(false);
    expect(askOwnsKeystrokes(canvas)).toBe(false);
    expect(askOwnsKeystrokes(body)).toBe(false);
    expect(askOwnsKeystrokes(null)).toBe(false);
  });

  it('treats the mounted Ask popover as present independently of focus', () => {
    expect(askOverlayPresent({ querySelector: selector => selector === '.ask-popover' ? {} : null })).toBe(true);
    expect(askOverlayPresent({ querySelector: () => null })).toBe(false);
    expect(askOverlayPresent(null)).toBe(false);
    expect(askOverlayPresent(undefined)).toBe(false);
  });

  it('lets the Ask textarea and popover own keystrokes the way search does', () => {
    expect(keystrokeOwnedByTextEntry(askInput)).toBe(true);
    expect(keystrokeOwnedByTextEntry(askSubmit)).toBe(true);
    expect(keystrokeOwnedByTextEntry(canvas)).toBe(false);
  });
});

describe('Escape on Ask never cancels the semantic lens', () => {
  it('lets Escape close the Ask overlay without cancelling the semantic lens or refitting the camera', () => {
    const escape = escapeBranch();
    const askGuard = escape.indexOf('if (askOpen || askOwnsKeystrokes(event.target)) { setAskOpen(false);');
    const lensCancel = escape.indexOf("cancelSemanticLens('escape')");
    const askReturn = escape.indexOf('return;', askGuard);

    expect(askGuard).toBeGreaterThan(0);
    expect(lensCancel).toBeGreaterThan(askGuard);
    expect(askReturn).toBeGreaterThan(askGuard);
    expect(askReturn).toBeLessThan(lensCancel);
    expect(escape.slice(askGuard, lensCancel)).not.toContain('cancelSemanticLens');
    expect(escape.slice(askGuard, lensCancel)).not.toContain('semanticZoomControl(');
    expect(escape.slice(askGuard, lensCancel)).not.toContain('updateCamera(');
    expect(escape.slice(askGuard, lensCancel)).not.toContain('frameEntities(');
    expect(escape).toContain('setAskOpen(false)');
  });

  it('still cancels the semantic lens on Escape when Ask is closed', () => {
    const escape = escapeBranch();
    const askGuard = escape.indexOf('askOpen || askOwnsKeystrokes(event.target)');
    const lensCancel = escape.indexOf("cancelSemanticLens('escape')");

    expect(escape).toContain("cancelSemanticLens('escape')");
    expect(askGuard).toBeGreaterThan(0);
    expect(askGuard).toBeLessThan(lensCancel);
    expect(escape).toContain("setAuthoringTool('select')");
  });

  it('preserves search Escape owning the keystroke ahead of Ask and lens cancel', () => {
    const escape = escapeBranch();
    const searchGuard = escape.indexOf("if (searchOwnsKeystrokes(event.target)) { setSearchOpen(false); return; }");
    const askGuard = escape.indexOf('if (askOpen || askOwnsKeystrokes(event.target))');

    expect(searchGuard).toBeGreaterThan(0);
    expect(searchGuard).toBeLessThan(askGuard);
    expect(askGuard).toBeLessThan(escape.indexOf("cancelSemanticLens('escape')"));
    expect(searchOwnsKeystrokes(searchInput)).toBe(true);
    expect(askOwnsKeystrokes(searchInput)).toBe(false);
  });

  it('stops Ask key events from propagating into canvas lens-cancel', () => {
    expect(askInputMarkup).toContain("onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setAskOpen(false);");
    expect(askInputMarkup).toContain('onKeyPress={event => event.stopPropagation()}');
    expect(askInputMarkup).not.toContain('cancelSemanticLens');
    expect(canvasKeyHandler).toContain('if (searchOwnsKeystrokes(event.target)) return;');
    expect(canvasKeyHandler).toContain('askOwnsKeystrokes(event.target) || askOverlayPresent(document)');
    expect(canvasKeyHandler.indexOf('askOverlayPresent')).toBeLessThan(canvasKeyHandler.indexOf('onLensCancelRef.current'));
    expect(canvasKeyHandler.indexOf('askOwnsKeystrokes')).toBeLessThan(canvasKeyHandler.indexOf('onLensCancelRef.current'));
  });
});
