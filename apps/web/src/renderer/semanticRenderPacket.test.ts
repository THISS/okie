import { describe, expect, it } from 'vitest';
import type { AtlasScene, ProjectionOverride } from './types';
import { semanticRenderFrame } from './semanticRenderPacket';

const scene = { id: 'scene' } as AtlasScene;
const oldProjection = { id: 'old', progress: .8766, objects: [], paths: [] } satisfies ProjectionOverride;
const newProjection = { id: 'new', progress: .9497, objects: [], paths: [] } satisfies ProjectionOverride;
const oldSession = {};
const newSession = {};

describe('semantic render packet', () => {
  it('never pairs an immediately-live semantic camera with React’s previous projection', () => {
    const oldCamera = { x: -192.576, y: 513.586, zoom: 5.3569 };
    const newCamera = { x: -195.993, y: 581.885, zoom: 5.5565 };
    const result = semanticRenderFrame({ revision: 7, camera: newCamera, scene, semanticSession: newSession, projectionOverride: newProjection }, newCamera, {
      revision: 6,
      camera: oldCamera,
      scene,
      semanticSession: oldSession,
      projectionOverride: oldProjection,
    });

    expect(result.frame.camera).toBe(newCamera);
    expect(result.frame.projectionOverride).toBe(newProjection);
    expect(result.frame.revision).toBe(7);
    expect(result.acknowledged).toBe(false);
  });

  it('keeps packet geometry with a newer live camera until the matching React session acknowledges it', () => {
    const packetCamera = { x: 1, y: 2, zoom: 3 };
    const newerLiveCamera = { x: 10, y: 20, zoom: 2 };
    const fallback = { revision: 4, camera: newerLiveCamera, scene, semanticSession: oldSession, projectionOverride: oldProjection };
    const pending = { revision: 3, camera: packetCamera, scene, semanticSession: newSession, projectionOverride: newProjection };

    const beforeAck = semanticRenderFrame(pending, newerLiveCamera, fallback);
    expect(beforeAck.frame.camera).toEqual(newerLiveCamera);
    expect(beforeAck.frame.projectionOverride).toBe(newProjection);
    expect(beforeAck.acknowledged).toBe(false);

    const afterAck = semanticRenderFrame(pending, newerLiveCamera, { ...fallback, semanticSession: newSession, projectionOverride: newProjection });
    expect(afterAck.frame.projectionOverride).toBe(newProjection);
    expect(afterAck.acknowledged).toBe(true);
  });
});
