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
