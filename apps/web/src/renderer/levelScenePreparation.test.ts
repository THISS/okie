import { expect, it, vi } from 'vitest';
import { clearLevelScenePreparation, LEVEL_SCENE_PREPARING, finishLevelScenePreparation, levelScenePreparationPending, runLevelSceneGesture } from './levelScenePreparation';
it('holds selected compile priority against pan and releases it on completion', () => {
  const request = new AbortController();
  const owner = { current: request as AbortController | undefined };
  expect(levelScenePreparationPending(owner.current)).toBe(true);
  expect(finishLevelScenePreparation(owner, request)).toBe(true);
  expect(levelScenePreparationPending(owner.current)).toBe(false);
});
it('cancellation releases gesture priority and old completion cannot clear a newer level', () => {
  const old = new AbortController(); old.abort();
  expect(levelScenePreparationPending(old)).toBe(false);
  const next = new AbortController(); const owner = { current: next as AbortController | undefined };
  expect(finishLevelScenePreparation(owner, old)).toBe(false);
  expect(levelScenePreparationPending(owner.current)).toBe(true);
});

it('keeps camera movement but never runs reverse or morph scope transitions while a level prepares', () => {
  const request = new AbortController();
  const camera = { x: 10, y: 20, zoom: 2 };
  const transition = vi.fn(() => ({ ...camera, zoom: 3 }));
  expect(runLevelSceneGesture(request, camera, transition)).toBe(camera);
  expect(transition).not.toHaveBeenCalled();
  finishLevelScenePreparation({ current: request }, request);
  expect(runLevelSceneGesture(undefined, camera, transition).zoom).toBe(3);
  expect(transition).toHaveBeenCalledTimes(1);
});

it('clears a cancelled level immediately while its fetch remains unresolved and protects a newer cue', () => {
  const old = new AbortController();
  const owner = { current: old as AbortController | undefined };
  let message = LEVEL_SCENE_PREPARING;
  const updateMessage = (update: (current: string) => string) => { message = update(message); };
  const unresolvedFetch = new Promise<void>(() => {});
  void unresolvedFetch;
  old.signal.addEventListener('abort', () => clearLevelScenePreparation(owner, old, updateMessage));
  old.abort();
  expect(owner.current).toBeUndefined();
  expect(message).toContain('cancelled');
  const next = new AbortController(); owner.current = next; message = LEVEL_SCENE_PREPARING;
  clearLevelScenePreparation(owner, old, updateMessage);
  expect(owner.current).toBe(next);
  expect(message).toBe(LEVEL_SCENE_PREPARING);
});
