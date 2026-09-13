import { existsSync, statSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import type { OperatorPublicationService } from "./operatorPublication.js";
import type { OperatorStore } from "./operatorStore.js";

/** Per-repo slug for the THISS/okie dogfood atlas (matches web `DOGFOOD_ATLAS_SLUG`). */
export const DOGFOOD_SCAN_SLUG = "thiss__okie";

const PUBLISHED_BASENAMES = new Set([
  "snapshot.json",
  "view.json",
  "story.json",
  "stories.json",
  "scene.json",
  "timeline.json",
  "extraction.json",
  "enrichment-report.json",
  "enrichment-status.json",
  "index.json",
]);

/**
 * Relative paths under the scan root to try for one `/scan/...` request.
 *
 * Hosted `/r/THISS/okie` fetches `/scan/thiss__okie/neighborhood.json` (CLA-73)
 * plus `story.json` and `stories.json`. Full `{snapshot,view,story}.json` remain published.
 * A local `okie-scan` still writes the self-scan at the scan-root trio
 * (`fixtures/scan/snapshot.json`), so that slot aliases onto the dogfood slug.
 */
export function publishedScanCandidates(relativePosix: string): string[] {
  const relative = relativePosix.replace(/\\/g, "/").replace(/^\/+/, "");
  if (relative === "" || relative.includes("..")) return [];
  const parts = relative.split("/");
  const name = parts.at(-1);
  if (!name || !PUBLISHED_BASENAMES.has(name) || parts.length > 2) return [];
  const candidates = [relative];
  const prefix = `${DOGFOOD_SCAN_SLUG}/`;
  if (relative.startsWith(prefix)) {
    const basename = relative.slice(prefix.length);
    if (PUBLISHED_BASENAMES.has(basename) && !basename.includes("/")) {
      candidates.push(basename);
    }
  }
  return candidates;
}

/**
 * Absolute file inside `scanRoot` for a `/scan/...` pathname, or undefined
 * when the path escapes the tree or no candidate exists as a file.
 */
export function resolvePublishedScanFile(scanRoot: string, pathname: string): string | undefined {
  if (!pathname.startsWith("/scan/")) return undefined;
  const relative = normalize(decodeURIComponent(pathname.slice("/scan/".length))).replace(/\\/g, "/");
  for (const candidate of publishedScanCandidates(relative)) {
    const target = resolve(scanRoot, candidate);
    if (target !== scanRoot && !target.startsWith(scanRoot + sep)) continue;
    if (existsSync(target) && statSync(target).isFile()) return target;
  }
  return undefined;
}

/** Resolves a current or explicitly pinned immutable publication before legacy slots. */
export function resolvePublicationScanFile(input: { scanRoot: string; pathname: string; repositoryId?: string; versionId?: string; publications?: OperatorPublicationService; store?: OperatorStore }): string | undefined {
  const { scanRoot, pathname, repositoryId, versionId, publications, store } = input;
  if (repositoryId && publications && store && pathname.startsWith("/scan/")) {
    const relative = normalize(decodeURIComponent(pathname.slice(6))).replace(/\\/g, "/");
    const file = relative.split("/").at(-1);
    if (file && (PUBLISHED_BASENAMES.has(file) || file === "operator-explanations.json") && relative.split("/").length <= 2) {
      const artifact = versionId ? publications.artifactForVersion(repositoryId, versionId) : publications.currentPublication(repositoryId) && publications.artifactForVersion(repositoryId, publications.currentPublication(repositoryId)!.versionId);
      if (artifact?.files.includes(file!)) {
        const path = resolve(store.root, "artifacts", artifact.artifactRevisionId, file!);
        if (path.startsWith(resolve(store.root, "artifacts") + sep) && existsSync(path)) return path;
      }
    }
    // A known repository request must never fall back to mutable legacy bytes when
    // a version was requested or publication metadata exists.
    if (versionId || publications.currentPublication(repositoryId)) return undefined;
  }
  return resolvePublishedScanFile(scanRoot, pathname);
}
