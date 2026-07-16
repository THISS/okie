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
