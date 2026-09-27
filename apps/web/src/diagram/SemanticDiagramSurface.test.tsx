import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildC4ProjectionBundle } from '@okie/architecture';
import { compileC4DynamicFlowArtifact, goldenSnapshot, goldenStory, goldenView, serializeDynamicFlowMermaid } from '@okie/scene-compiler';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { SemanticDiagramSurface, semanticDiagramPreview, semanticDiagramStatus } from './SemanticDiagramSurface';
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

describe('semantic diagram C4 notation status (CLA-130)', () => {
  const scene = createGoldenC4Scene();
  const relation = scene.relations.find(candidate => candidate.from !== candidate.to)!;
  const surface: DerivedDiagramSurface = { id: 'dependencies', kind: 'dependency', title: 'Dependencies', closable: true, entityIds: [relation.from, relation.to], session: { inspector: { open: false, tab: 'details' } } };
  const render = (props: { devMode?: boolean; notationAdvisoryCount?: number }) => renderToStaticMarkup(<SemanticDiagramSurface scene={scene} surface={surface} onSessionChange={() => undefined} {...props}/>);

  it('hides C4 notation status from users while keeping the neutral context line', () => {
    for (const notationAdvisoryCount of [0, 1, 4337]) {
      const markup = render({ notationAdvisoryCount });
      expect(markup).not.toContain('C4 notation');
      expect(markup).not.toMatch(/advisor/i);
      expect(markup).not.toContain('data-notation-advisories');
      expect(markup).toContain('Derived from the active architecture view');
      expect(markup).toContain('semantic-diagram-readiness context');
    }
  });

  it('shows C4 notation status in dev mode', () => {
    const advisory = render({ devMode: true, notationAdvisoryCount: 4337 });
    expect(advisory).toContain('4337 C4 notation advisories');
    expect(advisory).toContain('data-notation-advisories="4337"');
    expect(advisory).toContain('semantic-diagram-readiness advisory');
    const ready = render({ devMode: true, notationAdvisoryCount: 0 });
    expect(ready).toContain('C4 notation ready');
    expect(ready).toContain('data-notation-advisories="0"');
  });

  it('shows neutral no-explanation copy for a diagram element without a summary', () => {
    const entity = { ...scene.entities.find(candidate => candidate.id === relation.from)!, responsibility: 'No summary supplied.' };
    const blankScene = { ...scene, entities: scene.entities.map(candidate => candidate.id === entity.id ? entity : candidate) };
    const open: DerivedDiagramSurface = { ...surface, session: { selectedElementId: entity.id, inspector: { open: true, tab: 'details', subjectId: entity.id } } };
    const markup = renderToStaticMarkup(<SemanticDiagramSurface scene={blankScene} surface={open} onSessionChange={() => undefined}/>);
    expect(markup).toContain('data-diagram-element-no-explanation');
    expect(markup).toContain('No explanation captured yet.');
    expect(markup).not.toContain('No summary supplied.');
    const described = renderToStaticMarkup(<SemanticDiagramSurface scene={scene} surface={{ ...open, session: { selectedElementId: relation.from, inspector: { open: true, tab: 'details', subjectId: relation.from } } }} onSessionChange={() => undefined}/>);
    expect(described).not.toContain('No explanation captured yet.');
  });

  it('keeps the flow step context for users', () => {
    expect(semanticDiagramStatus({ flowStepCount: 4, notationAdvisoryCount: 9 })).toEqual({ context: '4 ordered steps · semantic and evidence links retained' });
    expect(semanticDiagramStatus({ devMode: true, flowStepCount: 1, notationAdvisoryCount: 1 })).toEqual({
      context: '1 ordered step · semantic and evidence links retained',
      notation: { tone: 'advisory', label: '1 C4 notation advisory' },
    });
  });
});
