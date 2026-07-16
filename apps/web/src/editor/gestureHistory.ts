export type GestureHistory<T> = {
  past: T[];
  present: T;
  future: T[];
};

export function createGestureHistory<T>(initial: T): GestureHistory<T> {
  return { past: [], present: initial, future: [] };
}

/** Commits one completed pointer/keyboard gesture as exactly one history item. */
export function commitGesture<T>(history: GestureHistory<T>, next: T): GestureHistory<T> {
  if (Object.is(history.present, next)) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: [],
  };
}

export function undoGesture<T>(history: GestureHistory<T>): GestureHistory<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoGesture<T>(history: GestureHistory<T>): GestureHistory<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
