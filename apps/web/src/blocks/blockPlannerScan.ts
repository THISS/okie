/**
 * The published scan the Jev block planner plans against (CLA-149). Dependency-free so the boot path
 * can set it without pulling the block modules into the entry chunk.
 */
export interface BlockPlanScan { slug: string; versionId: string }
let activeScan: BlockPlanScan | undefined;
/** Set once the exact immutable publication is known; cleared for drafts and portable atlases. */
export function setBlockPlannerScan(scan: BlockPlanScan | undefined): void { activeScan = scan; }
export function getBlockPlannerScan(): BlockPlanScan | undefined { return activeScan; }

export const BLOCK_PLANNER_STORAGE_KEY = 'okie.blockPlanner';
let queryFlag = false;
/**
 * Reads `?planner=jev` once at boot, before the app rewrites the URL (navigation state drops unknown
 * params), and keeps it for this page load.
 */
export function captureBlockPlannerQueryFlag(search: string): void { if (new URLSearchParams(search).get('planner') === 'jev') queryFlag = true; }
export function blockPlannerQueryFlag(): boolean { return queryFlag; }
/** Test seam. */
export function resetBlockPlannerQueryFlag(): void { queryFlag = false; }
