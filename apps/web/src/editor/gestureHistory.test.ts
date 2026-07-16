import { describe, expect, it } from 'vitest';
import { commitGesture, createGestureHistory, redoGesture, undoGesture } from './gestureHistory';

describe('gesture history', () => {
  it('records each committed gesture once and clears redo after a branch', () => {
    const initial = { route: [0] };
    const first = { route: [0, 1] };
    const second = { route: [0, 1, 2] };
    let history = createGestureHistory(initial);
    history = commitGesture(history, first);
    history = commitGesture(history, second);
    expect(history).toMatchObject({ past: [initial, first], present: second, future: [] });

    history = undoGesture(history);
    expect(history).toMatchObject({ present: first, future: [second] });
    history = commitGesture(history, { route: [9] });
    expect(history.future).toEqual([]);
    expect(history.past).toEqual([initial, first]);
  });

  it('round-trips undo and redo without adding phantom entries', () => {
    const initial = { revision: 1 };
    const committed = { revision: 2 };
    const history = commitGesture(createGestureHistory(initial), committed);
    expect(redoGesture(undoGesture(history))).toEqual(history);
    expect(undoGesture(createGestureHistory(initial))).toEqual(createGestureHistory(initial));
  });
});
