/**
 * CLA-319: the structure card renderer's version, kept apart from the renderer so the edge Worker can name the stored
 * card's key (`versions/<v>/card-<version>.png`) without bundling the scene compiler.
 *
 * Bump (r1 → r2) whenever apps/web/src/atlasStructureCard.ts renders different pixels for the same atlas: stored cards
 * are immutable and keyed by this version, so a bump makes `/og` fall back to the generated card until
 * `pnpm publish:atlas --backfill-cards` renders the new version beside the old ones (never overwriting them). Run the
 * backfill before deploying the Worker that reads the new key (the running one never reads it).
 * apps/web/src/atlasStructureCard.test.ts pins reference pixels to this value (see STRUCTURE_CARD_REFERENCE_SHA256).
 */
export const STRUCTURE_CARD_RENDERER_VERSION = 'r1';

/**
 * sha256 of the inflated pixels (IDAT data, zlib-independent) of the reference card: the golden self-map
 * (@okie/scene-compiler `goldenSnapshot`/`goldenView`) printed as THISS/okie, as rendered by this renderer version.
 * The vitest pin and the publish-time self-check (`structureCardSelfCheck`, run by scripts/publish-atlas.mjs before it
 * stores any card) both compare against it, so a stale workspace build or a runtime that lays text out differently can
 * never store a permanent card under this version. Re-pin together with a version bump.
 */
export const STRUCTURE_CARD_REFERENCE_SHA256 = '0df2f54724e2bf4cdb2a8548d7e17701b59a37fd10afe9a072f0fd036dc569c8';
