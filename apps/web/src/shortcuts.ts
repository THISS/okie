type AskShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'repeat' | 'target'>;

function isFormControlTarget(target: EventTarget | null) {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as Element).closest;
  if (typeof closest !== 'function') return false;
  return Boolean(closest.call(target, 'input, textarea, select, button, [contenteditable="true"], [role="textbox"]'));
}

export function shouldOpenAskAtlas(event: AskShortcutEvent, storyActive: boolean) {
  return !storyActive
    && !event.repeat
    && event.key === 'Enter'
    && (event.metaKey || event.ctrlKey)
    && !isFormControlTarget(event.target);
}

const SEARCH_INPUT_ID = 'atlas-search';

const SEARCH_KEYSTROKE_SELECTOR = `#${SEARCH_INPUT_ID}, .search-popover`;

/**
 * The search field owns every keystroke aimed at it: the `#atlas-search` input itself and any
 * control inside the search popover. Keyboard events name their focused element as `target`, so
 * this is exactly "search is focused". Canvas and camera hotkeys — zoom, authoring tools, select,
 * Enter-to-open-inside, and Escape's semantic-lens cancel — must not fire for those keystrokes:
 * typing a query is not a camera intent (CLA-6). Jumping to a search *result* is a separate,
 * deliberate act and may still frame its destination.
 */
export function searchOwnsKeystrokes(target: EventTarget | null) {
  if (!target || typeof target !== 'object') return false;
  const element = target as Element;
  if (element.id === SEARCH_INPUT_ID) return true;
  const closest = element.closest;
  if (typeof closest !== 'function') return false;
  return Boolean(closest.call(element, SEARCH_KEYSTROKE_SELECTOR));
}

/**
 * The single gate every canvas/camera hotkey is behind: the keystroke already belongs to a text
 * entry surface, so the map must not read it as pan, zoom, select, or an authoring tool. Structural
 * (`tagName` / `isContentEditable`) rather than `instanceof`, so it is unit-testable without a DOM
 * and realm-independent in the browser.
 */
export function keystrokeOwnedByTextEntry(target: EventTarget | null) {
  if (searchOwnsKeystrokes(target)) return true;
  if (!target || typeof target !== 'object') return false;
  const element = target as Element & { isContentEditable?: boolean };
  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable === true;
}

type DevModeShortcutEvent = Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'repeat'>;

/**
 * Diagnostics/dev mode toggle: Shift+Alt+D. Uses the physical `code` (KeyD) so it is
 * independent of keyboard layout and of Alt key-composition, and deliberately excludes
 * Cmd/Ctrl so it cannot clash with browser or OS chords.
 */
export function shouldToggleDevMode(event: DevModeShortcutEvent) {
  return !event.repeat
    && event.altKey
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && event.code === 'KeyD';
}
