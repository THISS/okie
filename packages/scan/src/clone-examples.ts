/**
 * Type-2 token/AST clone pair for the CLA-61 self-scan. These are existing L4
 * code entities the clone walk overlays a `duplicates` edge between — not extra
 * nodes and not a second parser.
 */

/** Type-2 clone partner of `cloneTokenBodyBeta`. */
export function cloneTokenBodyAlpha(value: number): number {
  if (value > 0) {
    const next = value + 1;
    if (next % 2 === 0) return next * 3;
    return next - 1;
  }
  return 0;
}

/** Type-2 clone partner of `cloneTokenBodyAlpha` (identifiers renamed). */
export function cloneTokenBodyBeta(count: number): number {
  if (count > 0) {
    const next = count + 1;
    if (next % 2 === 0) return next * 3;
    return next - 1;
  }
  return 0;
}
