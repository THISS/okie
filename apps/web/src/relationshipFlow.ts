export type RelationshipFlowPolicyInput = {
  reducedMotion: boolean;
  interactionMode: 'view' | 'edit';
  selectedRelationIds: ReadonlySet<string>;
  storyRelationIds: ReadonlySet<string>;
  storyHoldPlaying: boolean;
};

export type RelationshipFlowPolicy = {
  relationIds: Set<string>;
  active: boolean;
  owner: 'none' | 'selection' | 'story';
};

/** Story flow owns playback; otherwise View animates only the selected relationship. */
export function relationshipFlowPolicy(input: RelationshipFlowPolicyInput): RelationshipFlowPolicy {
  if (input.reducedMotion) return { relationIds: new Set(), active: false, owner: 'none' };
  if (input.storyHoldPlaying && input.storyRelationIds.size) {
    return { relationIds: new Set(input.storyRelationIds), active: true, owner: 'story' };
  }
  if (input.interactionMode === 'view' && input.selectedRelationIds.size) {
    return { relationIds: new Set(input.selectedRelationIds), active: true, owner: 'selection' };
  }
  return { relationIds: new Set(), active: false, owner: 'none' };
}
