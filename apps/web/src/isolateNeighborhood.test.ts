import { VIEWPORT_RESIDENT_NODES_PER_BAND } from '@okie/architecture';
import { describe, expect, it } from 'vitest';
import {
  ISOLATE_NEIGHBORHOOD_MAX,
  isolateNeighborhoodIds,
  type IsolateNeighborhoodEntity,
} from './isolateNeighborhood';
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
  it('lifts a code story step to the owning file and sibling files, not every declaration', () => {
    const ids = isolateNeighborhoodIds(atlas, [headers.id], { liftCodeStoryFocus: true });
    expect(ids).toEqual([webmcp.id, otherFile.id, headers.id]);
    expect(ids).not.toEqual([headers.id]);
    expect(ids).not.toContain(system.id);
    expect(ids).not.toContain(container.id);
    expect(ids).not.toContain(isolateTool.id);
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

  it('keeps a co-focused container as itself while lifting only the code neighborhood', () => {
    expect(isolateNeighborhoodIds(atlas, [container.id, headers.id], { liftCodeStoryFocus: true }))
      .toEqual([container.id, webmcp.id, otherFile.id, headers.id]);
  });

  it('keeps an orphan code leaf when the parent is missing', () => {
    expect(isolateNeighborhoodIds(atlas, [orphanLeaf.id], { liftCodeStoryFocus: true }))
      .toEqual([orphanLeaf.id]);
  });

  it('unions owning files when a story step focuses code in different files', () => {
    const ids = isolateNeighborhoodIds(atlas, [headers.id, appFn.id], { liftCodeStoryFocus: true });
    expect(ids).toEqual([webmcp.id, otherFile.id, headers.id, appFn.id]);
    expect(ids).not.toContain(isolateTool.id);
  });

  it('ignores focus ids that are not in the scene', () => {
    expect(isolateNeighborhoodIds(atlas, ['missing'], { liftCodeStoryFocus: true })).toEqual([]);
  });

  it('does not dump a fat file’s declarations (CLA-89)', () => {
    const fat = Array.from({ length: 127 }, (_, index) =>
      entity(`code:webmcp:decl-${String(index).padStart(3, '0')}`, 'code', webmcp.id));
    const siblingFiles = Array.from({ length: 8 }, (_, index) =>
      entity(`component:peer-${index}`, 'component', container.id));
    const scene = [system, container, webmcp, ...siblingFiles, ...fat];
    const isolated = isolateNeighborhoodIds(scene, [fat[0]!.id], { liftCodeStoryFocus: true });
    expect(isolated).toContain(webmcp.id);
    expect(isolated).toContain(fat[0]!.id);
    expect(isolated).toContain(siblingFiles[0]!.id);
    expect(isolated).not.toContain(fat[50]!.id);
    expect(isolated.length).toBe(1 + siblingFiles.length + 1);
    expect(isolated.length).toBeLessThanOrEqual(ISOLATE_NEIGHBORHOOD_MAX);
    expect(isolated.filter(id => id.startsWith('code:'))).toEqual([fat[0]!.id]);
  });

  it('caps a missing-owner code dump at the healthy sibling window', () => {
    const leaf = entity('code:webmcp:host-headers', 'code', 'component:webmcp');
    const crowd = Array.from({ length: 80 }, (_, index) =>
      entity(`code:webmcp:decl-${index}`, 'code', 'component:webmcp'));
    const isolated = isolateNeighborhoodIds([leaf, ...crowd], [leaf.id], { liftCodeStoryFocus: true });
    expect(isolated).toContain(leaf.id);
    expect(isolated.length).toBe(ISOLATE_NEIGHBORHOOD_MAX);
    expect(ISOLATE_NEIGHBORHOOD_MAX).toBe(VIEWPORT_RESIDENT_NODES_PER_BAND);
    expect(ISOLATE_NEIGHBORHOOD_MAX).toBe(50);
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
    expect(isolated).toContain(otherFile.id);
    expect(isolated).not.toContain(isolateTool.id);
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
