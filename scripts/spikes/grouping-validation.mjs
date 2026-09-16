/** Structural guards for the experiment, not semantic proof of LLM prose. */
import { isDeepStrictEqual } from 'node:util';

/** Grouping may reparent symbols, never rewrite their observed facts or calls. */
export function validateSymbolPreservation(base, mapped) {
  const errors = [];
  const symbols = base.entities.filter(entity => entity.kind === 'code');
  const after = new Map(mapped.entities.filter(entity => entity.kind === 'code').map(entity => [entity.id, entity]));
  if (after.size !== symbols.length) errors.push('symbol inventory changed');
  for (const symbol of symbols) {
    const { parentId: beforeParent, ...beforeFacts } = symbol;
    const { parentId: afterParent, ...afterFacts } = after.get(symbol.id) ?? {};
    if (!isDeepStrictEqual(beforeFacts, afterFacts)) errors.push(`symbol facts changed: ${symbol.id}`);
  }
  const ids = new Set(symbols.map(entity => entity.id));
  const observed = base.relations.filter(relation => ids.has(relation.from) && ids.has(relation.to));
  const retained = mapped.relations.filter(relation => ids.has(relation.from) && ids.has(relation.to));
  const byId = new Map(retained.map(relation => [relation.id, relation]));
  if (retained.length !== observed.length) errors.push('symbol relationship inventory changed');
  for (const relation of observed) if (!isDeepStrictEqual(relation, byId.get(relation.id))) errors.push(`symbol relationship changed: ${relation.id}`);
  return { accepted: errors.length === 0, symbolsChecked: symbols.length, symbolRelationshipsChecked: observed.length, errors };
}

export function validateExplanation(value, request) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['not an object'];
  const allowed = new Set(request.input.facts.map(e => e.id));
  if (typeof value.summary !== 'string' || !value.summary.trim()) errors.push('missing summary');
  if (!Array.isArray(value.evidenceEntityIds) || !value.evidenceEntityIds.length || value.evidenceEntityIds.some(id => !allowed.has(id))) errors.push('missing or unknown entity evidence');
  const relations = new Set(request.input.relations.map(r => r.id));
  if (!Array.isArray(value.observedRelationIds) || value.observedRelationIds.some(id => !relations.has(id))) errors.push('unknown relationship evidence');
  if (!Array.isArray(value.uncertainties) || value.uncertainties.some(item => typeof item !== 'string')) errors.push('missing or malformed uncertainties');
  if (request.stage === 'leaf' && (typeof value.responsibility !== 'string' || !value.responsibility.trim())) errors.push('missing leaf responsibility');
  return errors;
}

export function validatePartition(value, paths) {
  if (!Array.isArray(value?.components) || !Array.isArray(value?.unassignedPaths)) return ['missing partition'];
  const errors = [];
  const assigned = [];
  for (const component of value.components) {
    if (!component || typeof component !== 'object' || !Array.isArray(component.paths)) { errors.push('malformed component'); continue; }
    if (typeof component.id !== 'string' || !/^component:probe-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(component.id)) errors.push('invalid proposed component ID');
    for (const field of ['name', 'responsibility', 'rationale']) if (typeof component[field] !== 'string' || !component[field].trim()) errors.push(`missing component ${field}`);
    if (!component.paths.length) errors.push('empty component');
    assigned.push(...component.paths);
  }
  const partition = [...assigned, ...value.unassignedPaths];
  if (partition.length !== paths.length || new Set(partition).size !== paths.length || partition.some(path => !paths.includes(path))) errors.push('partition lost, duplicated or invented a file');
  return errors;
}

/** Compare membership independently of unstable names, IDs, prose and ordering.
 * Unassigned files remain singleton groups, not one fictitious component. */
export function compareMembership(left, right, paths) {
  const normalize = value => [...value.components.map(c => [...c.paths].sort()), ...value.unassignedPaths.map(path => [path])].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const a = normalize(left), b = normalize(right);
  const sameGroup = (groups, x, y) => groups.some(group => group.includes(x) && group.includes(y));
  let same = 0, total = 0;
  for (let i=0;i<paths.length;i++) for (let j=i+1;j<paths.length;j++) { total++; if (sameGroup(a,paths[i],paths[j]) === sameGroup(b,paths[i],paths[j])) same++; }
  return { membershipIdentical: JSON.stringify(a) === JSON.stringify(b), pairAgreement: total ? same / total : 1, comparedPairs: total, leftGroups: a, rightGroups: b };
}
