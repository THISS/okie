import { expect, it } from 'vitest';
import { finishLevelScenePreparation, levelScenePreparationPending } from './levelScenePreparation';
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
