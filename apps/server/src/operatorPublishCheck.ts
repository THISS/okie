import { isDeepStrictEqual } from "node:util";
import { parsePortableAtlas } from "@okie/architecture";
import { normalizeRepoInput } from "./repoUrl.js";
import type { OperatorStore } from "./operatorStore.js";

const REQUIRED = ["atlas.okie.json", "snapshot.json", "view.json", "scene.json", "story.json", "stories.json", "timeline.json"];

/**
 * Publish-time artifact validation (shared by the publish route and CLA-271 auto-publish): every public file is present
 * and parses, the portable bundle names the run's repository and commit, and its snapshot/view/story equal the stored files.
 */
export function isPublishableArtifact(store: OperatorStore, artifactRevisionId: string, source: { owner: string; repo: string; commitSha?: string }): boolean {
  const artifact = store.snapshot().artifacts.find(item => item.artifactRevisionId === artifactRevisionId);
  const bundle = store.readArtifactFile(artifactRevisionId, "atlas.okie.json");
  try {
    if (!artifact || REQUIRED.some(file => !artifact.files.includes(file)) || !bundle) return false;
    const portable = parsePortableAtlas(bundle.toString("utf8"));
    const original = JSON.parse(bundle.toString("utf8")) as { snapshot: unknown; view: unknown; story: unknown };
    const repository = portable.repository.url ? normalizeRepoInput(portable.repository.url) : undefined;
    if (!repository || repository.owner.toLowerCase() !== source.owner.toLowerCase() ||
        repository.repo.toLowerCase() !== source.repo.toLowerCase() ||
        artifact.sourceCommitSha !== portable.repository.commitSha ||
        (source.commitSha && source.commitSha !== portable.repository.commitSha)) return false;
    const read = (name: string): unknown => JSON.parse(store.readArtifactFile(artifact.artifactRevisionId, name)!.toString("utf8"));
    // Semantic repository IDs are scanner-owned, distinct from the operator's
    // owner/repo key. Compare the actual immutable contents instead.
    if (!isDeepStrictEqual(read("snapshot.json"), original.snapshot) ||
        !isDeepStrictEqual(read("view.json"), original.view) ||
        !isDeepStrictEqual(read("story.json"), original.story)) return false;
    for (const name of ["scene.json", "stories.json", "timeline.json"]) read(name);
    return true;
  } catch { return false; }
}
