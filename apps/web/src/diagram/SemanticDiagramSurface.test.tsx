import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildC4ProjectionBundle } from '@okie/architecture';
import { compileC4DynamicFlowArtifact, goldenSnapshot, goldenStory, goldenView, serializeDynamicFlowMermaid } from '@okie/scene-compiler';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { SemanticDiagramSurface, semanticDiagramPreview } from './SemanticDiagramSurface';
import type { DerivedDiagramSurface } from './diagramWorkspace';

describe('semantic diagram surface', () => {
  it('projects stable participants and ordered canonical interactions without mounting a renderer', () => {
    const scene = createGoldenC4Scene();
    const relation = scene.relations.find(candidate => candidate.from !== candidate.to)!;
    const surface: DerivedDiagramSurface = {
      id: 'diagram:flow:1',
      kind: 'flow',
      title: 'Request flow',
      closable: true,
      entityIds: [relation.from, relation.to],
      session: { inspector: { open: false, tab: 'details' } },
    };
    const preview = semanticDiagramPreview(scene, surface);

    expect(preview.participants.map(participant => participant.id)).toEqual([relation.from, relation.to]);
    expect(preview.interactions).toContainEqual(expect.objectContaining({
      id: relation.id,
      sourceId: relation.from,
      targetId: relation.to,
      sequence: expect.any(Number),
    }));
    expect(preview.interactions.map(interaction => interaction.sequence))
      .toEqual(preview.interactions.map((_, index) => index + 1));
  });

  it('uses the compiled dynamic artifact ordering and preserves evidence-backed semantic relation IDs', () => {
    const scene = createGoldenC4Scene();
    const projections = buildC4ProjectionBundle(goldenSnapshot, {
      rootEntityId: goldenView.rootEntityId,
      focusEntityId: goldenView.rootEntityId,
    });
    const artifact = compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, goldenStory, projections);
    const surface: DerivedDiagramSurface = {
      id: artifact.id,
      kind: 'flow',
      title: artifact.title,
      closable: true,
      entityIds: artifact.participants.map(participant => participant.id),
      session: { inspector: { open: false, tab: 'details' } },
    };

    const preview = semanticDiagramPreview(scene, surface, artifact);

    expect(preview.interactions.map(interaction => interaction.sequence)).toEqual([1, 2, 3, 4]);
    expect(preview.interactions[0]).toMatchObject({
      semanticRelationId: goldenStory.steps[0]?.traceRelationIds?.[0],
      evidenceCount: expect.any(Number),
    });
    expect(preview.participants.map(participant => participant.id))
      .toEqual(artifact.participants.map(participant => participant.id));
  });

  it('presents rendered Mermaid first while retaining the accessible outline and source disclosure', () => {
    const scene = createGoldenC4Scene();
    const projections = buildC4ProjectionBundle(goldenSnapshot, {
      rootEntityId: goldenView.rootEntityId,
      focusEntityId: goldenView.rootEntityId,
    });
    const artifact = compileC4DynamicFlowArtifact(goldenSnapshot, goldenView, goldenStory, projections);
    const source = serializeDynamicFlowMermaid(artifact);
    const surface: DerivedDiagramSurface = {
      id: 'diagram:mermaid:golden',
      kind: 'mermaid',
      title: artifact.title,
      closable: true,
      entityIds: artifact.participants.map(participant => participant.id),
      session: { inspector: { open: false, tab: 'details' } },
    };

    const markup = renderToStaticMarkup(<SemanticDiagramSurface
      flowArtifact={artifact}
      mermaidSource={source}
      onSessionChange={() => undefined}
      scene={scene}
      surface={surface}
    />);

    const renderedView = markup.indexOf('semantic-mermaid-diagram');
    const participants = markup.indexOf('semantic-participants');
    expect(renderedView).toBeGreaterThan(0);
    expect(participants).toBeGreaterThan(renderedView);
    expect(markup).toContain('Rendering diagram');
    expect(markup).toContain('The structured outline below is the accessible');
    expect(markup).toContain('Generated Mermaid source');
    expect(markup).toContain('aria-pressed="true"');
  });
});

it('labels dependency relations without invented sequence and offers Mermaid in the same tab', () => {
  const scene = createGoldenC4Scene();
  const relation = scene.relations.find(candidate => candidate.from !== candidate.to)!;
  const markup = renderToStaticMarkup(<SemanticDiagramSurface scene={scene} surface={{ id: 'dependencies', kind: 'dependency', title: 'Dependencies', closable: true, entityIds: [relation.from, relation.to], session: { inspector: { open: false, tab: 'details' } } }} onSessionChange={() => undefined}/>);
  expect(markup).toContain('View Mermaid');
  expect(markup).toContain('<ul>');
  expect(markup).not.toContain('<ol>');
  expect(markup).not.toContain('ordered interactions');
});

it('keeps an invalid optional named flow in a local alert without inventing fallback interactions', () => {
  const scene = createGoldenC4Scene();
  const markup = renderToStaticMarkup(<SemanticDiagramSurface scene={scene} flowError="Captured flow unavailable; return to Main." surface={{ id: 'invalid-flow', kind: 'flow', title: 'Invalid flow', closable: true, entityIds: scene.entities.slice(0, 2).map(entity => entity.id), session: { inspector: { open: false, tab: 'details' } } }} onSessionChange={() => undefined}/>);
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Captured flow unavailable; return to Main.');
  expect(markup).not.toContain('data-semantic-relation-id');
});
