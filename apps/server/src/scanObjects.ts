import { existsSync, statSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

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
