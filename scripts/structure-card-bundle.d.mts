// Types for scripts/structure-card-bundle.mjs (CLA-319), for apps/web/src/structureCardBundle.test.ts.
export type StructureCardSelfCheck = { ok: boolean; sha256: string; expected: string; version: string };
export type LoadedStructureCardRenderer = {
  version: string;
  render: (input: { snapshot: unknown; view: unknown; label: { owner: string; repo: string } }) => Uint8Array;
  selfCheck: () => StructureCardSelfCheck;
};
export function structureCardBuildOptions(repoRoot: string, outfile: string): Record<string, unknown>;
export function loadStructureCardRenderer(repoRoot: string): Promise<LoadedStructureCardRenderer>;
