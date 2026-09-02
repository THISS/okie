import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isolateNeighborhoodIds, type IsolateNeighborhoodEntity } from './isolateNeighborhood';
import { storyFocusPresentation } from './storyFocus';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

const changeVisibility = sliceBetween(app, 'function changeVisibility', 'function restoreVisibility', 'changeVisibility');
const restoreVisibility = sliceBetween(app, 'function restoreVisibility', 'function composeScene', 'restoreVisibility');

function entity(
  id: string,
  detail: IsolateNeighborhoodEntity['detail'],
  parentId?: string,
): IsolateNeighborhoodEntity {
  return { id, detail, ...(parentId ? { parentId } : {}) };
}

const fileComponent = entity('component:webmcp', 'component', 'container:web-app');
const sibling = entity('code:webmcp:isolate-tool', 'code', 'component:webmcp');
const leaf = entity('code:webmcp:host-headers', 'code', 'component:webmcp');
const container = entity('container:web-app', 'container', 'system:okie');
const scene = [container, fileComponent, leaf, sibling];

describe('CLA-55: isolate from a code story step keeps a file-component neighborhood', () => {
  it('does not collapse a code story step to a single leaf', () => {
    const story = storyFocusPresentation('system:okie', [leaf.id], [], {
      storyOpen: true,
      selectionOverride: false,
    });
    const isolated = isolateNeighborhoodIds(scene, new Set([...story.requiredIds]), {
      liftCodeStoryFocus: true,
    });
    expect(story.requiredIds.size).toBe(1);
    expect(isolated).toEqual([fileComponent.id, leaf.id, sibling.id]);
    expect(isolated.length).toBeGreaterThan(1);
    expect(isolated).not.toContain(container.id);
  });

  it('still collapses a user-selected code leaf to that leaf', () => {
    const selected = storyFocusPresentation(leaf.id, [], [], {
      storyOpen: false,
      selectionOverride: false,
    });
    expect(isolateNeighborhoodIds(scene, selected.requiredIds, { liftCodeStoryFocus: false }))
      .toEqual([leaf.id]);
  });
});

describe('CLA-55 restore full view and CLA-11 isolate camera', () => {
  it('restores the pre-isolation camera, selection, and visibility without a new fit', () => {
    expect(restoreVisibility).toContain('isolationOriginRef.current');
    expect(restoreVisibility).toContain('setVisibilityMode(origin.visibilityMode)');
    expect(restoreVisibility).toContain('setSelectedId(origin.selectedId)');
    expect(restoreVisibility).toContain('updateCamera(origin.camera)');
    expect(restoreVisibility).not.toContain('frameProjectionScope(');
    expect(restoreVisibility).not.toContain('frameEntities(');
    expect(restoreVisibility).not.toContain('frameVisibleProjection(');
    expect(restoreVisibility).not.toContain('frameSemanticEntities(');
  });

  it('does not re-fit the camera when Isolate is turned on (CLA-11)', () => {
    expect(changeVisibility).toContain("next === 'isolate'");
    expect(changeVisibility).toContain('setVisibilityMode(next)');
    expect(changeVisibility).toContain('isolatedEntityIds.length');
    expect(changeVisibility).not.toContain('frameProjectionScope(');
    expect(changeVisibility).not.toContain('frameEntities(');
    expect(changeVisibility).not.toContain('frameVisibleProjection(');
    expect(changeVisibility).not.toContain('updateCamera(');
    expect(changeVisibility).not.toContain('navigateCamera(');
  });

  it('wires story-owned isolate through the neighborhood helper and canvas focus', () => {
    expect(app).toContain('isolateNeighborhoodIds(scene.entities, visibilityFocusIds');
    expect(app).toContain('liftCodeStoryFocus: currentStory !== undefined && storyPhase !== \'idle\' && !storySelectionOverride');
    expect(app).toContain("const focusedIds = visibilityMode === 'isolate' ? isolatedEntityIdSet : storyFocus.focusedIds");
    expect(app).toContain('canvasRelationRowsInIsolate(related, selected.id, isolatedEntityIdSet)');
    expect(app).not.toContain('row.semanticIds.some(id => isolatedRelationIdSet.has(id))');
  });
});
