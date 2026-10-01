// CLA-319: bundles apps/web/src/atlasStructureCard.ts for Node (apps/server cannot import apps/web) and imports it.
// Shared by scripts/publish-atlas.mjs and its test (apps/web/src/structureCardBundle.test.ts), so both use one esbuild
// config. Workspace packages resolve through node_modules from their built dist: build them first
// (`pnpm --filter './packages/*' build`; `pnpm check` does it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The esbuild options for the structure card bundle (entry under `repoRoot`, output `outfile`). */
export function structureCardBuildOptions(repoRoot, outfile) {
  return {
    entryPoints: [join(repoRoot, "apps/web/src/atlasStructureCard.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
    absWorkingDir: join(repoRoot, "apps/web"),
  };
}

/**
 * Bundles and imports the renderer. Resolves to `{ version, render, selfCheck }`: the `StructureCardRenderer`
 * publishAtlas.ts takes plus the pixel self-check (`{ ok, sha256, expected, version }`). The temporary bundle directory
 * is removed on success and on failure. Throws (with the cause) when esbuild is missing, the bundle fails, or the module
 * lacks its exports.
 */
export async function loadStructureCardRenderer(repoRoot) {
  const outDir = mkdtempSync(join(tmpdir(), "okie-structure-card-"));
  try {
    const esbuild = await import("esbuild");
    const outfile = join(outDir, "atlasStructureCard.mjs");
    await esbuild.build(structureCardBuildOptions(repoRoot, outfile));
    const module = await import(pathToFileURL(outfile).href);
    if (typeof module.renderAtlasStructureCardPng !== "function" || typeof module.STRUCTURE_CARD_RENDERER_VERSION !== "string" || typeof module.structureCardSelfCheck !== "function") {
      throw new Error("the bundled module has no renderAtlasStructureCardPng / STRUCTURE_CARD_RENDERER_VERSION / structureCardSelfCheck");
    }
    return { version: module.STRUCTURE_CARD_RENDERER_VERSION, render: module.renderAtlasStructureCardPng, selfCheck: module.structureCardSelfCheck };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
