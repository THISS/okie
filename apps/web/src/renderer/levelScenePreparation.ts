export const LEVEL_SCENE_PREPARING = 'Preparing the next detail level…';
/** Camera gestures may move the camera, but must not supersede this selected compile. */
export function levelScenePreparationPending(current: AbortController | undefined): boolean {
  return current !== undefined && !current.signal.aborted;
}
/** An obsolete level request never clears a newer request's ownership or message. */
export function finishLevelScenePreparation(owner: { current: AbortController | undefined }, request: AbortController): boolean {
  if (owner.current !== request) return false;
  owner.current = undefined;
  return true;
}

/** Preserve camera movement while deferring every semantic scope transition. */
export function runLevelSceneGesture<T>(current: AbortController | undefined, camera: T, transition: () => T): T {
  return levelScenePreparationPending(current) ? camera : transition();
}

export function clearLevelScenePreparation(owner: { current: AbortController | undefined }, request: AbortController, updateMessage: (update: (current: string) => string) => void): void {
  if (finishLevelScenePreparation(owner, request)) updateMessage(current => current === LEVEL_SCENE_PREPARING ? 'Detail level preparation cancelled. Choose a level to try again.' : current);
}
