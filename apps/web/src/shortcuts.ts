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
