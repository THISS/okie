import type { ArchitectureExtraction, PortableMembershipDiagnostic, PortableMembershipReport } from "@okie/architecture";
import { pureRelativeReexportSpecifiers, type ReexportAlias } from "./discover.js";
import { resolveRelativeImport } from "./extract.js";

export type MembershipDiagnostic = PortableMembershipDiagnostic;
export type MembershipReport = PortableMembershipReport;

/** One source file claimed by components/code in more than one container. */
interface ContainerMembershipOverlap {
  /** Repository-relative source path. */
  path: string;
  /** Sorted ids of every container whose components/code cite `path`. */
  containerIds: string[];
  /** Sorted ids of the claiming component/code entities. */
  entityIds: string[];
}

interface Claim { containers: Set<string>; entities: Set<string>; components: Set<string> }

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const sorted = (values: Iterable<string>): string[] => [...values].sort(byCodeUnit);

/** path -> the containers / entities citing it, via each component/code entity's owning container. */
function containerClaims(extraction: Pick<ArchitectureExtraction, "entities">): Map<string, Claim> {
  const byId = new Map(extraction.entities.map(entity => [entity.id, entity]));
  const containerOf = (id: string): string | undefined => {
    const seen = new Set<string>();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
      if (current.kind === "container") return current.id;
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return undefined;
  };
  const claims = new Map<string, Claim>();
  for (const entity of extraction.entities) {
    if (entity.kind !== "component" && entity.kind !== "code") continue;
    const container = containerOf(entity.id);
    if (!container) continue;
    for (const ref of entity.sourceRefs) {
      const claim = claims.get(ref.path) ?? { containers: new Set<string>(), entities: new Set<string>(), components: new Set<string>() };
      claim.containers.add(container);
      claim.entities.add(entity.id);
      if (entity.kind === "component") claim.components.add(entity.id);
      claims.set(ref.path, claim);
    }
  }
  return claims;
}

/**
 * Every source path cited from more than one container (walking each
 * component/code entity up to its container). Deterministic: sorted by path,
 * ids sorted within each overlap.
 */
function sourceFileContainerOverlaps(extraction: Pick<ArchitectureExtraction, "entities">): ContainerMembershipOverlap[] {
  const claims = containerClaims(extraction);
  return sorted(claims.keys())
    .filter(path => claims.get(path)!.containers.size > 1)
    .map(path => ({ path, containerIds: sorted(claims.get(path)!.containers), entityIds: sorted(claims.get(path)!.entities) }));
}

/**
 * CLA-263 container-membership diagnostics (warnings — never fatal):
 *
 * - `file-in-multiple-containers`: the same source path is cited from components/code
 *   in more than one container.
 * - `reexport-across-containers`: a component's file is a pure relative re-export
 *   (`export { default } from '../apps/web/api/share.ts'`) of a file owned by a
 *   DIFFERENT container — one logical file surfacing as two components (the
 *   thiss/okie `api/share.ts` shape, typically with an identical display name).
 *
 * The re-export check only inspects `nonMemberPaths` (files in the synthetic
 * tooling bucket): a workspace member's own barrel re-exporting another package
 * (`apps/web/src/core.ts` → `packages/core/src/util.ts`) is ordinary code, not a
 * membership fault. `readFile` reads committed source; unreadable paths are
 * skipped. Sorted by (code, path).
 */
export function membershipDiagnostics(
  extraction: Pick<ArchitectureExtraction, "entities">,
  readFile: (repoRelativePath: string) => string,
  nonMemberPaths: ReadonlySet<string>,
): MembershipDiagnostic[] {
  const claims = containerClaims(extraction);
  const nameById = new Map(extraction.entities.map(entity => [entity.id, entity.name]));
  const diagnostics: MembershipDiagnostic[] = sourceFileContainerOverlaps(extraction).map(overlap => ({
    code: "file-in-multiple-containers",
    severity: "warning",
    path: overlap.path,
    containerIds: overlap.containerIds,
    entityIds: overlap.entityIds,
    message: `${overlap.path} is claimed by ${overlap.containerIds.length} containers (${overlap.containerIds.join(", ")})`,
  }));
  const componentPaths = new Set([...claims].filter(([, claim]) => claim.components.size > 0).map(([path]) => path));
  for (const path of sorted(componentPaths)) {
    if (!nonMemberPaths.has(path)) continue;
    const claim = claims.get(path)!;
    let text: string;
    try { text = readFile(path); } catch { continue; }
    const specifiers = pureRelativeReexportSpecifiers(path, text);
    if (!specifiers) continue;
    const targets = new Set(specifiers.map(specifier => resolveRelativeImport(path, specifier, componentPaths)));
    if (targets.size !== 1) continue;
    const target = [...targets][0];
    const targetClaim = target && target !== path ? claims.get(target) : undefined;
    if (!target || !targetClaim) continue;
    const foreign = [...targetClaim.containers].filter(container => !claim.containers.has(container));
    if (foreign.length === 0) continue;
    const containerIds = sorted(new Set([...claim.containers, ...foreign]));
    const entityIds = sorted(new Set([...claim.components, ...targetClaim.components]));
    const names = sorted(new Set(entityIds.map(id => nameById.get(id) ?? id)));
    diagnostics.push({
      code: "reexport-across-containers",
      severity: "warning",
      path,
      target,
      containerIds,
      entityIds,
      message: `${path} only re-exports ${target} but is a separate component in another container (${containerIds.join(", ")}; ${names.length === 1 ? `same name "${names[0]}"` : `names ${names.map(name => `"${name}"`).join(", ")}`})`,
    });
  }
  return diagnostics.sort((left, right) => byCodeUnit(left.code, right.code) || byCodeUnit(left.path, right.path));
}

/** The persisted membership report: folded shims + diagnostics. */
export function membershipReport(
  reexportAliases: readonly ReexportAlias[] | undefined,
  diagnostics: readonly MembershipDiagnostic[],
): MembershipReport {
  return {
    reexportAliases: [...(reexportAliases ?? [])].map(alias => ({ ...alias })).sort((left, right) => byCodeUnit(left.path, right.path)),
    diagnostics: diagnostics.map(diagnostic => ({ ...diagnostic, containerIds: [...diagnostic.containerIds], entityIds: [...diagnostic.entityIds] })),
  };
}
