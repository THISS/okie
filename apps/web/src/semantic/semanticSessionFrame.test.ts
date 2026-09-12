import { describe, expect, it } from 'vitest';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import { frameEntities } from '../storyFraming';
import { compileScanFixture } from '../renderer/scanFixture';
import { reduceSemanticLensSession, semanticLensSessionDetail } from './semanticLens';
import { semanticLevelSession, semanticSessionFrameCamera } from './semanticLensEngine';

const viewport = { width: 623, height: 765 };
const safeArea = { top: 0, right: 278, bottom: 0, left: 0 };

describe('semantic session framing', () => {
  it('frames Show on map within the settled L3 zoom policy so the next inward sample keeps its ancestor path', () => {
    const scan = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    const scene = scan.createScene('container:web-app');
    const file = scene.entities.find(entity => entity.parentId === 'container:web-app' && entity.detail === 'component');
    expect(file).toBeDefined();
    const session = semanticLevelSession(scene, 'component', [file!.id]);
    expect(semanticLensSessionDetail(session)).toBe('component');

    // This is the former Show-on-map calculation: generic framing is capped at
    // the overview range even though the semantic session is already L3.
    expect(frameEntities(scene, [file!.id], viewport)?.zoom).toBe(1.24);

    const camera = semanticSessionFrameCamera(scene, file!.id, session, viewport, safeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(1.24);
    const next = reduceSemanticLensSession(session, {
      nowMs: 1,
      zoom: camera!.zoom * 1.035,
      direction: 'inward',
    });
    expect(next.active.phase).toBe('idle');
    expect(next.settled).toEqual(session.settled);
    expect(semanticLensSessionDetail(next)).toBe('component');
  });

  it('returns no semantic frame when the entity lacks the currently presented representation', () => {
    const scan = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    const scene = scan.createScene('container:web-app');
    const session = semanticLevelSession(scene, 'component', ['container:web-app']);
    const code = scene.entities.find(entity => entity.detail === 'code');
    expect(code).toBeDefined();
    expect(semanticSessionFrameCamera(scene, code!.id, session, viewport, safeArea)).toBeUndefined();
  });
});
