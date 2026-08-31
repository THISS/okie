import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keystrokeOwnedByTextEntry, searchOwnsKeystrokes, shouldOpenSearch } from './shortcuts';

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

const searchInput = element({ id: 'atlas-search', tagName: 'INPUT', ancestors: ['.search-popover'] });
const searchResult = element({ tagName: 'BUTTON', ancestors: ['.search-popover'] });
const searchClose = element({ tagName: 'BUTTON', ancestors: ['.search-popover'] });
const canvas = element({ tagName: 'DIV' });
const body = element({ tagName: 'BODY' });

/**
 * Everything a query can contain plus every canvas/camera hotkey that used to leak: zoom
 * (`+ - =`), authoring tools (`v` `c`), relationship delete (`Backspace` `Delete`), undo (`z`),
 * search reopen (`k`), lens cancel (`Escape`), and the arrow/edit keys a text field needs.
 */
const TYPED_KEYS = [
  'a', 'f', ' ', '+', '-', '=', '_', 'v', 'c', 'z', 'k',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Enter', 'Escape',
] as const;

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

const searchInputMarkup = (() => {
  const line = app.split('\n').find(candidate => candidate.includes('id="atlas-search"'));
  if (!line) throw new Error('Missing the #atlas-search input');
  return line;
})();

/** Anything in the window shortcut that moves the camera, refits the view, or retargets the canvas. */
const CANVAS_AND_CAMERA_EFFECTS = [
  'semanticZoomControl(',
  'cancelSemanticLens(',
  'setAuthoringTool(',
  'deleteSelectedRelationship(',
  'undoAuthoringGesture(',
  'redoAuthoringGesture(',
  'focusEntity(',
  'frameEntities(',
  'updateCamera(',
  'navigateCamera(',
  'reframeEntityAfterInspectorChange(',
];

/** Top-level `if` statements of the handler, each kept with its (6-space indented) body. */
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

describe('search owns its keystrokes', () => {
  it('claims the search input, the popover controls around it, and nothing on the canvas', () => {
    expect(searchOwnsKeystrokes(searchInput)).toBe(true);
    expect(searchOwnsKeystrokes(searchResult)).toBe(true);
    expect(searchOwnsKeystrokes(searchClose)).toBe(true);
    expect(searchOwnsKeystrokes(canvas)).toBe(false);
    expect(searchOwnsKeystrokes(body)).toBe(false);
    expect(searchOwnsKeystrokes(null)).toBe(false);
  });

  it('gates every canvas/camera hotkey key for a focused #atlas-search, and no key when the canvas is focused', () => {
    for (const key of TYPED_KEYS) {
      expect(keystrokeOwnedByTextEntry(searchInput), `key ${key} must stay inside search`).toBe(true);
      expect(keystrokeOwnedByTextEntry(searchResult), `key ${key} must stay inside the search popover`).toBe(true);
      // Not vacuous: the same keys are canvas intent when the canvas is what is focused.
      expect(keystrokeOwnedByTextEntry(canvas), `key ${key} must reach the canvas when search is not focused`).toBe(false);
    }
  });

  it('still treats other text-entry surfaces as owning their keystrokes', () => {
    expect(keystrokeOwnedByTextEntry(element({ tagName: 'INPUT' }))).toBe(true);
    expect(keystrokeOwnedByTextEntry(element({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(keystrokeOwnedByTextEntry(element({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(keystrokeOwnedByTextEntry(element({ tagName: 'BUTTON' }))).toBe(false);
  });
});

describe('typing in search never reaches the canvas or the camera', () => {
  it('routes the window shortcut gate through the shared keystroke guard', () => {
    expect(shortcutBody).toContain('const typing = keystrokeOwnedByTextEntry(event.target);');
  });

  it('keeps every camera/canvas effect in the window shortcut behind that guard', () => {
    const branches = topLevelBranches(shortcutBody);
    const effectful = branches.filter(branch => CANVAS_AND_CAMERA_EFFECTS.some(effect => branch.includes(effect)));

    expect(branches.length).toBeGreaterThan(5);
    expect(effectful.length).toBeGreaterThan(3);
    for (const branch of effectful) {
      const condition = branch.split('\n')[0]!;
      const firstEffect = Math.min(...CANVAS_AND_CAMERA_EFFECTS.filter(effect => branch.includes(effect)).map(effect => branch.indexOf(effect)));
      const searchGuard = branch.indexOf('searchOwnsKeystrokes(event.target)) { setSearchOpen(false); return; }');
      const guarded = condition.includes('!typing') || (searchGuard >= 0 && searchGuard < firstEffect);

      expect(guarded, `ungated canvas/camera hotkey: ${condition.trim()}`).toBe(true);
    }
  });

  it('lets Escape close the search popover without cancelling the semantic lens', () => {
    const escape = topLevelBranches(shortcutBody).find(branch => branch.startsWith("      if (event.key === 'Escape')"))!;
    const guard = escape.indexOf("if (searchOwnsKeystrokes(event.target)) { setSearchOpen(false); return; }");

    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(escape.indexOf("cancelSemanticLens('escape')"));
    expect(guard).toBeLessThan(escape.indexOf("setAuthoringTool('select')"));
    expect(guard).toBeLessThan(escape.indexOf('closeDetails()'));
  });

  it('stops search key events from propagating into canvas handlers', () => {
    expect(searchInputMarkup).toContain("onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); } }}");
    expect(searchInputMarkup).toContain('onKeyPress={event => event.stopPropagation()}');
    expect(searchInputMarkup).not.toContain('cancelSemanticLens');
    expect(canvasKeyHandler).toContain('if (searchOwnsKeystrokes(event.target)) return;');
    expect(canvasKeyHandler.indexOf('searchOwnsKeystrokes')).toBeLessThan(canvasKeyHandler.indexOf('onLensCancelRef.current'));
    expect(canvasKeyHandler.indexOf('searchOwnsKeystrokes')).toBeLessThan(canvasKeyHandler.indexOf('onOpenInside(selectedId)'));
  });

  it('never frames, focuses, or moves the camera while the query is being typed', () => {
    expect(searchInputMarkup).toContain('onChange={event => setSearch(event.target.value)}');
    for (const effect of [...CANVAS_AND_CAMERA_EFFECTS, 'setSelectedId(']) {
      expect(searchInputMarkup, `typing must not run ${effect}`).not.toContain(effect);
    }
  });

  it('still frames on an explicit jump to a search result', () => {
    // Product spec (docs/product/interaction-semantics.md): a search jump may frame its
    // destination. That is selecting a result, not typing a query.
    expect(app).toContain("onClick={() => focusEntity(entity, 'push', 'frame')}");
  });
});

describe('Cmd+K does not re-fire while typing in search', () => {
  const searchChordBranch = (() => {
    const branch = topLevelBranches(shortcutBody).find(candidate =>
      candidate.includes("event.key.toLowerCase() === 'k'") || candidate.includes('shouldOpenSearch(event)')
    );
    if (!branch) throw new Error('Missing the window Cmd+K search shortcut branch');
    return branch;
  })();

  it('opens search from Cmd/Ctrl+K when search is not focused', () => {
    expect(shouldOpenSearch({ key: 'k', metaKey: true, ctrlKey: false, repeat: false, target: canvas })).toBe(true);
    expect(shouldOpenSearch({ key: 'k', metaKey: false, ctrlKey: true, repeat: false, target: body })).toBe(true);
    expect(shouldOpenSearch({ key: 'K', metaKey: true, ctrlKey: false, repeat: false, target: null })).toBe(true);
    expect(searchChordBranch).toContain('setSearchOpen(true)');
    expect(searchChordBranch).toContain("document.getElementById('atlas-search')?.focus()");
  });

  it('does not toggle, re-open, or re-focus search while #atlas-search or the popover is focused', () => {
    expect(shouldOpenSearch({ key: 'k', metaKey: true, ctrlKey: false, repeat: false, target: searchInput })).toBe(false);
    expect(shouldOpenSearch({ key: 'k', metaKey: false, ctrlKey: true, repeat: false, target: searchResult })).toBe(false);
    expect(shouldOpenSearch({ key: 'k', metaKey: true, ctrlKey: false, repeat: false, target: searchClose })).toBe(false);
    expect(searchChordBranch).toContain('if (!shouldOpenSearch(event)) return;');
    expect(searchChordBranch.indexOf('shouldOpenSearch(event)')).toBeLessThan(searchChordBranch.indexOf('setSearchOpen(true)'));
  });
});
