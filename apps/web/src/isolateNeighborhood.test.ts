import { describe, expect, it } from 'vitest';
import { isolateNeighborhoodIds, type IsolateNeighborhoodEntity } from './isolateNeighborhood';
import { storyFocusPresentation } from './storyFocus';

function entity(
  id: string,
  detail: IsolateNeighborhoodEntity['detail'],
  parentId?: string,
): IsolateNeighborhoodEntity {
  return { id, detail, ...(parentId ? { parentId } : {}) };
}

const system = entity('system:okie', 'context');
const container = entity('container:web-app', 'container', 'system:okie');
const webmcp = entity('component:webmcp', 'component', 'container:web-app');
const otherFile = entity('component:app-shell', 'component', 'container:web-app');
const headers = entity('code:webmcp:host-headers', 'code', 'component:webmcp');
const isolateTool = entity('code:webmcp:isolate-tool', 'code', 'component:webmcp');
const appFn = entity('code:web-shell:app', 'code', 'component:app-shell');
const orphanLeaf = entity('code:orphan:leaf', 'code');

const atlas: IsolateNeighborhoodEntity[] = [
  system, container, webmcp, otherFile, headers, isolateTool, appFn, orphanLeaf,
];

describe('isolateNeighborhoodIds', () => {
  it('lifts a code story step to the owning file-component neighborhood, not a single leaf', () => {
    const ids = isolateNeighborhoodIds(atlas, [headers.id], { liftCodeStoryFocus: true });
    expect(ids).toEqual([webmcp.id, headers.id, isolateTool.id]);
    expect(ids).not.toEqual([headers.id]);
    expect(ids).not.toContain(system.id);
    expect(ids).not.toContain(container.id);
    expect(ids).not.toContain(otherFile.id);
    expect(ids).not.toContain(appFn.id);
  });

  it('keeps a user-selected code leaf as a single entity', () => {
    expect(isolateNeighborhoodIds(atlas, [headers.id], { liftCodeStoryFocus: false }))
      .toEqual([headers.id]);
  });

  it('does not lift a component story step into its container or descendants', () => {
    expect(isolateNeighborhoodIds(atlas, [webmcp.id], { liftCodeStoryFocus: true }))
      .toEqual([webmcp.id]);
  });

  it('keeps a co-focused container as itself while expanding only the code neighborhood', () => {
    expect(isolateNeighborhoodIds(atlas, [container.id, headers.id], { liftCodeStoryFocus: true }))
      .toEqual([container.id, webmcp.id, headers.id, isolateTool.id]);
  });

  it('keeps an orphan code leaf when the parent is missing', () => {
    expect(isolateNeighborhoodIds(atlas, [orphanLeaf.id], { liftCodeStoryFocus: true }))
      .toEqual([orphanLeaf.id]);
  });

  it('unions neighborhoods when a story step focuses code in different files', () => {
    const ids = isolateNeighborhoodIds(atlas, [headers.id, appFn.id], { liftCodeStoryFocus: true });
    expect(ids).toEqual([webmcp.id, otherFile.id, headers.id, isolateTool.id, appFn.id]);
  });

  it('ignores focus ids that are not in the scene', () => {
    expect(isolateNeighborhoodIds(atlas, ['missing'], { liftCodeStoryFocus: true })).toEqual([]);
  });
});

describe('CLA-55 isolate from a code story step', () => {
  it('expands story-owned code focus through storyFocus requiredIds', () => {
    const story = storyFocusPresentation('system:okie', [headers.id], [], {
      storyOpen: true,
      selectionOverride: false,
    });
    const isolated = isolateNeighborhoodIds(atlas, story.requiredIds, { liftCodeStoryFocus: true });
    expect([...story.requiredIds]).toEqual([headers.id]);
    expect(isolated.length).toBeGreaterThan(1);
    expect(isolated).toContain(webmcp.id);
    expect(isolated).toContain(headers.id);
    expect(isolated).toContain(isolateTool.id);
  });

  it('does not expand when the reader overrides the story with a leaf selection', () => {
    const overridden = storyFocusPresentation(headers.id, [webmcp.id], [], {
      storyOpen: true,
      selectionOverride: true,
    });
    expect(isolateNeighborhoodIds(atlas, overridden.requiredIds, { liftCodeStoryFocus: false }))
      .toEqual([headers.id]);
  });
});
