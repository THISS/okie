/**
 * Pure decisions behind Ask's "Show on map" / "Restore full view" and the
 * Ask panel's reframe (CLA-265). App.tsx owns the refs and effects; these
 * helpers decide when an async step may still act, when the saved
 * pre-Show view is stale, and when opening the panel may move the camera.
 */

export type AskMapVisibility = 'all' | 'dim' | 'isolate';

/**
 * A Show on map runs across awaits and animation frames (load neighborhoods →
 * drill → settle → isolate + frame). Each later step may act only while no
 * user action has superseded it: the generation is unchanged (every user
 * navigation / visibility change / chip bumps it) and, once the drill has
 * selected its target, the inspector still shows that target.
 */
export function askMapStepIsCurrent(
  step: { generation: number; target?: string },
  live: { generation: number; selectionId?: string },
): boolean {
  if (step.generation !== live.generation) return false;
  return step.target === undefined || step.target === live.selectionId;
}

/**
 * The saved pre-Show view and the Ask highlight belong to the Ask isolate. Any
 * path that takes the map out of isolate (toolbar, history, story exit,
 * relationship reframe, portable load, Restore) makes them stale.
 */
export function askMapViewShouldReset(previous: AskMapVisibility, next: AskMapVisibility): boolean {
  return previous === 'isolate' && next !== 'isolate';
}

/**
 * Capture the view Restore returns to. Keep the first capture across repeated
 * Shows from an Ask isolate (and while a Show is still in flight), so Restore
 * goes back to where the user was before any Show; re-capture when the map is
 * not currently an Ask isolate.
 */
export function askMapShouldCaptureReturn(state: { hasReturn: boolean; askIsolateActive: boolean; showInFlight: boolean }): boolean {
  return !state.hasReturn || (!state.askIsolateActive && !state.showInFlight);
}

export type AskPanelLayout = 'closed' | 'empty' | 'thread';

/**
 * The camera moves for the Ask panel only in answer to a gesture: opening Ask
 * (click / shortcut / tour hand-off) or submitting a question bumps `request`.
 * A thread loading asynchronously, or the panel reappearing after a story,
 * never reframes. Due once per request, when the panel is showing.
 */
export function askPanelReframeDue(layout: AskPanelLayout, request: number, handled: number): boolean {
  return layout !== 'closed' && request > handled;
}
