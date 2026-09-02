import { ASPECT_PRESET_TARGET, validateSnapshot, type ArchitectureAuthoringDocument } from '@okie/architecture';
import { createC4Scene } from '../renderer/goldenC4Scene';
import type { AtlasScene } from '../renderer/types';
import { IMPORTED_MERMAID_REVISION, type ImportedMermaidAtlas } from './importMermaid';

export function compileImportedMermaidScene(
  atlas: ImportedMermaidAtlas,
  previous?: AtlasScene,
  focusEntityId = atlas.rootEntityId,
  authoring?: ArchitectureAuthoringDocument,
): AtlasScene {
  const issues = validateSnapshot(atlas.snapshot);
  if (issues.length) {
    throw new Error(issues.map(issue => `${issue.path} ${issue.message}`).join('; '));
  }
  const root = atlas.snapshot.entities.find(entity => entity.id === atlas.rootEntityId);
  if (!root) throw new Error(`Imported Mermaid snapshot is missing root ${atlas.rootEntityId}`);
  const focus = atlas.snapshot.entities.some(entity => entity.id === focusEntityId)
    ? focusEntityId
    : atlas.rootEntityId;
  return createC4Scene({
    baseSnapshot: atlas.snapshot,
    rootEntityId: atlas.rootEntityId,
    focusEntityId: focus,
    familyId: `view-family:${atlas.snapshot.repositoryId}:${focus}`,
    sceneId: `okie-imported-mermaid:${atlas.snapshot.id}`,
    title: atlas.title,
    subtitle: 'Imported Mermaid diagram',
    frozenRevision: IMPORTED_MERMAID_REVISION,
    previous,
    authoring,
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
}
