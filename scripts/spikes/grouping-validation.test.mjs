import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExplanation, validatePartition, compareMembership, validateSymbolPreservation } from './grouping-validation.mjs';
const paths = ['a.ts','b.ts','c.ts'];
const group = { id:'component:probe-source', name:'Source', responsibility:'Reads source', rationale:'Shared interface', paths:['a.ts','b.ts'] };
const proposal = { components:[group], unassignedPaths:['c.ts'] };
test('allows reparenting but rejects changed symbols, anchors, or observed relationship evidence', () => {
  const base = { entities: [{id:'code:a', kind:'code', parentId:'component:file', sourceRefs:[{path:'a.ts',startLine:3}]}], relations:[{id:'relation:a', from:'code:a', to:'code:a', kind:'calls', evidence:[{source:{path:'a.ts',startLine:4}}]}] };
  const mapped = structuredClone(base);
  mapped.entities[0].parentId = 'component:group';
  assert.equal(validateSymbolPreservation(base, mapped).accepted, true);
  for (const mutate of [value => value.entities[0].sourceRefs[0].startLine++, value => value.entities.pop(), value => value.relations[0].evidence.pop(), value => value.relations.push({...value.relations[0],id:'relation:invented'})]) {
    const broken = structuredClone(mapped); mutate(broken);
    assert.equal(validateSymbolPreservation(base, broken).accepted, false);
  }
});
test('rejects missing, duplicate, invented ownership and rationale without throwing', () => {
  assert.deepEqual(validatePartition(proposal,paths),[]);
  for(const value of [null, {components:[null],unassignedPaths:[]}, {components:[{...group,rationale:''}],unassignedPaths:['c.ts']}, {components:[group],unassignedPaths:['b.ts']}, {components:[group],unassignedPaths:['invented.ts']}]) assert.ok(validatePartition(value,paths).length);
});
test('membership comparison ignores prose and ordering, but detects changed boundaries', () => {
  const renamed = {components:[{...group,id:'component:probe-new',name:'Different',paths:['b.ts','a.ts']}],unassignedPaths:['c.ts']};
  assert.equal(compareMembership(proposal,renamed,paths).membershipIdentical,true);
  const changed = {components:[{...group,paths:['b.ts','c.ts']}],unassignedPaths:['a.ts']};
  assert.equal(compareMembership(proposal,changed,paths).membershipIdentical,false);
  assert.equal(compareMembership(proposal,changed,paths).pairAgreement,1/3);
});
test('a known global relation outside the supplied leaf packet is rejected', () => {
  const request = {stage:'leaf',input:{facts:[{id:'code:a'}],relations:[{id:'relation:a'}]}};
  const value = {summary:'Summary',responsibility:'Role',evidenceEntityIds:['code:a'],observedRelationIds:['relation:a'],uncertainties:[]};
  assert.deepEqual(validateExplanation(value,request),[]);
  assert.ok(validateExplanation({...value,observedRelationIds:['relation:other-leaf']},request).length);
  assert.ok(validateExplanation({...value,evidenceEntityIds:['code:invented']},request).length);
  assert.ok(validateExplanation({...value,uncertainties:undefined},request).length);
});
