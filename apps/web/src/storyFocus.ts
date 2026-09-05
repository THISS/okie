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

/** Inspector/canvas subject for a story step: the first focus id present in the scene. */
export function storyStepSelectedId(
  focusEntityIds: readonly string[],
  presentEntityIds: Iterable<string>,
): string | undefined {
  const present = presentEntityIds instanceof Set ? presentEntityIds : new Set(presentEntityIds);
  return focusEntityIds.find(id => present.has(id)) ?? focusEntityIds[0];
}

export { isolateNeighborhoodIds } from './isolateNeighborhood';
