export type StoryFocusPresentation = {
  selectedId?: string;
  focusedIds: Set<string>;
  relationIds: Set<string>;
  requiredIds: Set<string>;
};

export function storyFocusPresentation(
  selectedId: string,
  targetIds: readonly string[],
  targetRelationIds: readonly string[],
  options: {
    storyOpen: boolean;
    selectionOverride: boolean;
    pickedRelationId?: string;
  },
): StoryFocusPresentation {
  if (!options.storyOpen || options.selectionOverride) {
    return {
      selectedId,
      focusedIds: new Set(),
      relationIds: new Set(options.pickedRelationId ? [options.pickedRelationId] : []),
      requiredIds: new Set([selectedId]),
    };
  }
  const focusedIds = new Set(targetIds);
  return {
    ...(focusedIds.has(selectedId) ? { selectedId } : {}),
    focusedIds,
    relationIds: new Set(targetRelationIds),
    requiredIds: new Set(targetIds),
  };
}

export { isolateNeighborhoodIds } from './isolateNeighborhood';
