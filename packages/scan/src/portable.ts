import { serializePortableAtlas, type PortableAtlas } from '@okie/architecture';
import type { ScanArtifacts } from './scan.js';

export function portableAtlasFromScan(artifacts: ScanArtifacts, repositoryUrl?: string): PortableAtlas {
  const bundle: PortableAtlas = {
    format: 'okie-atlas', version: 1,
    repository: { commitSha: artifacts.pin.commitSha, treeHash: artifacts.pin.treeHash, ...(repositoryUrl ? { url: repositoryUrl } : {}) },
    snapshot: artifacts.snapshot, view: artifacts.view, story: artifacts.story, stories: artifacts.stories,
    analysis: artifacts.analysis,
    ...(artifacts.sources ? { sources: artifacts.sources } : {}),
  };
  serializePortableAtlas(bundle);
  return bundle;
}
