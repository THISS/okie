import assert from 'node:assert/strict';
import test from 'node:test';
import { buildC4ProjectionBundle, type ArchitectureSnapshot, type ArchitectureStory, type ArchitectureView, type C4ProjectionBundle } from '@okie/architecture';
import { compileC4DynamicFlowArtifact, escapeMermaidLabel, mermaidSafeIdentifier, serializeDynamicFlowMermaid } from './dynamic-flow.js';
import { goldenSnapshot, goldenStory, goldenView } from './golden-fixture.js';

const projections = () => buildC4ProjectionBundle(goldenSnapshot, {
  rootEntityId: goldenView.rootEntityId,
  focusEntityId: goldenView.rootEntityId,
});

function multiRelationStory(): ArchitectureStory {
  return {
    ...goldenStory,
    steps: [
      {
        ...goldenStory.steps[0]!,
        focusEntityIds: ['system:okie', 'actor:developer'],
        traceRelationIds: [
          'relation:okie-renders-browser',
          'relation:developer-explores-okie',
        ],
      },
      goldenStory.steps[1]!,
    ],
  };
}

test('compiles authored step order and deterministic within-step relation order', () => {
  const artifact = compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, multiRelationStory(), projections());

  assert.deepEqual(artifact.interactions.map(item => [item.sequence, item.semanticRelationId]), [
    [1, 'relation:developer-explores-okie'],
    [2, 'relation:okie-renders-browser'],
    [3, 'relation:model-to-compiler'],
  ]);
  assert.deepEqual(artifact.steps[0]?.interactionIds, artifact.interactions.slice(0, 2).map(item => item.id));
  assert.deepEqual(artifact.participants.map(item => item.id), [...artifact.participants.map(item => item.id)].sort());
  assert.ok(artifact.steps[0]?.focusVisualNodeIds.length);
  assert.ok(artifact.interactions[0]?.projection.visualEdgeIds.length);
});

test('retains semantic relation, projection, and pinned evidence linkage', () => {
  const bundle = projections();
  const artifact = compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, goldenStory, bundle);
  const interaction = artifact.interactions[0]!;
  const relation = goldenSnapshot.relations.find(item => item.id === interaction.semanticRelationId)!;

  assert.equal(interaction.fromEntityId, relation.from);
  assert.equal(interaction.toEntityId, relation.to);
  assert.deepEqual(interaction.evidence, relation.evidence);
  assert.equal(interaction.evidence[0]?.source.commitSha, goldenSnapshot.commitSha);
  assert.equal(interaction.projection.id, bundle.family.projectionIds[interaction.projection.band]);
  assert.ok(interaction.projection.visualEdgeIds.every(id =>
    bundle.index.relationIdsByVisualEdgeId[id]?.includes(interaction.semanticRelationId),
  ));
});

test('serializes safe Mermaid identifiers, escaped labels, and machine-readable linkage comments', () => {
  const hostileSnapshot: ArchitectureSnapshot = {
    ...goldenSnapshot,
    entities: goldenSnapshot.entities.map(entity => entity.id === 'actor:developer'
      ? { ...entity, name: 'Dev "]\nclick bad | {x}' }
      : entity),
    relations: goldenSnapshot.relations.map(relation => relation.id === 'relation:developer-explores-okie'
      ? { ...relation, label: 'opens "atlas" | --> bad [x] <tag>' }
      : relation),
  };
  const hostileProjections = buildC4ProjectionBundle(hostileSnapshot, {
    rootEntityId: goldenView.rootEntityId,
    focusEntityId: goldenView.rootEntityId,
  });
  const artifact = compileC4DynamicFlowArtifact(hostileSnapshot, goldenView, goldenStory, hostileProjections);
  const mermaid = serializeDynamicFlowMermaid(artifact, { direction: 'TB' });

  assert.match(mermaid, /^%% okie-dynamic-flow .+\nflowchart TB\n/u);
  assert.ok(artifact.participants.every(item => /^[A-Za-z][A-Za-z0-9_]*$/u.test(item.mermaidId)));
  assert.ok(mermaid.includes('&quot;atlas&quot; &#124; --&gt; bad &#91;x&#93; &lt;tag&gt;'));
  assert.ok(mermaid.includes('Dev &quot;&#93; click bad &#124; &#123;x&#125;'));
  assert.ok(!mermaid.includes('\nclick bad'));
  assert.ok(mermaid.includes('"semanticRelationId":"relation:developer-explores-okie"'));
  assert.ok(mermaid.includes('"evidenceSources":["README.md"]'));
  assert.equal(mermaidSafeIdentifier('relation:a-b'), mermaidSafeIdentifier('relation:a-b'));
  assert.notEqual(mermaidSafeIdentifier(':'), mermaidSafeIdentifier('_3a_'));
  assert.equal(escapeMermaidLabel(' a\n| "b" '), 'a &#124; &quot;b&quot;');

  const tampered = {
    ...artifact,
    participants: artifact.participants.map((item, index) => index === 0 ? { ...item, mermaidId: 'bad --> injected' } : item),
    id: `${artifact.id}\u2028injected`,
  };
  const hardened = serializeDynamicFlowMermaid(tampered);
  assert.ok(!hardened.includes('bad --> injected'));
  assert.ok(hardened.includes('\\u2028injected'));
  assert.throws(
    () => serializeDynamicFlowMermaid(artifact, { direction: 'RL' as 'LR' }),
    /Unsupported Mermaid flow direction/u,
  );
});

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = Math.imul(state ^ (state >>> 15), 2_246_822_519) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function shuffledRecord<T>(record: Readonly<Record<string, T>>, seed: number): Record<string, T> {
  return Object.fromEntries(shuffled(Object.entries(record), seed));
}

function randomizedBundle(bundle: C4ProjectionBundle, seed: number): C4ProjectionBundle {
  return {
    ...bundle,
    projectionById: Object.fromEntries(shuffled(Object.entries(bundle.projectionById), seed + 1).map(([id, projection]) => [id, {
      ...projection,
      visualNodeIds: shuffled(projection.visualNodeIds, seed + 2),
      visualEdgeIds: shuffled(projection.visualEdgeIds, seed + 3),
      contextNodeIds: shuffled(projection.contextNodeIds, seed + 4),
    }])),
    visualNodeById: shuffledRecord(bundle.visualNodeById, seed + 5),
    visualEdgeById: shuffledRecord(bundle.visualEdgeById, seed + 6),
    bandLayoutById: shuffledRecord(bundle.bandLayoutById, seed + 7),
    index: {
      entityIdByVisualNodeId: shuffledRecord(bundle.index.entityIdByVisualNodeId, seed + 8),
      visualNodeIdsByEntityId: Object.fromEntries(shuffled(Object.entries(bundle.index.visualNodeIdsByEntityId), seed + 9)
        .map(([id, values]) => [id, shuffled(values, seed + 10)])),
      relationIdsByVisualEdgeId: Object.fromEntries(shuffled(Object.entries(bundle.index.relationIdsByVisualEdgeId), seed + 11)
        .map(([id, values]) => [id, shuffled(values, seed + 12)])),
      visualEdgeIdsByRelationId: Object.fromEntries(shuffled(Object.entries(bundle.index.visualEdgeIdsByRelationId), seed + 13)
        .map(([id, values]) => [id, shuffled(values, seed + 14)])),
      boundsByEntityIdAndBand: shuffledRecord(bundle.index.boundsByEntityIdAndBand, seed + 15),
    },
  };
}

test('is deterministic across randomized semantic and projection input ordering', () => {
  const story = multiRelationStory();
  const bundle = projections();
  const expected = compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, story, bundle);
  const expectedMermaid = serializeDynamicFlowMermaid(expected);

  for (let seed = 1; seed <= 20; seed += 1) {
    const snapshot: ArchitectureSnapshot = {
      ...goldenSnapshot,
      entities: shuffled(goldenSnapshot.entities, seed).map(entity => ({
        ...entity,
        technology: shuffled(entity.technology ?? [], seed + 20),
        sourceRefs: shuffled(entity.sourceRefs, seed + 21),
      })),
      relations: shuffled(goldenSnapshot.relations, seed + 22).map(relation => ({
        ...relation,
        evidence: shuffled(relation.evidence, seed + 23),
      })),
    };
    const view: ArchitectureView = {
      ...goldenView,
      entityIds: shuffled(goldenView.entityIds, seed + 24),
      relationIds: shuffled(goldenView.relationIds, seed + 25),
    };
    const randomizedStory: ArchitectureStory = {
      ...story,
      steps: story.steps.map(step => ({
        ...step,
        focusEntityIds: shuffled(step.focusEntityIds, seed + 26),
        traceRelationIds: shuffled(step.traceRelationIds ?? [], seed + 27),
        sourceRefs: shuffled(step.sourceRefs ?? [], seed + 28),
      })),
    };
    const artifact = compileC4DynamicFlowArtifact(snapshot, view, randomizedStory, randomizedBundle(bundle, seed));
    assert.deepEqual(artifact, expected);
    assert.equal(serializeDynamicFlowMermaid(artifact), expectedMermaid);
  }
});

test('rejects story/projection snapshot mismatches', () => {
  const bundle = projections();
  const mismatched = { ...bundle, family: { ...bundle.family, snapshotId: 'snapshot:other' } };
  assert.throws(
    () => compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, goldenStory, mismatched),
    /projections for another snapshot/u,
  );
});
