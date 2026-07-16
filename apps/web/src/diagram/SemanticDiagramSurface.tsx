import { ArrowIcon, CloseIcon, FileIcon } from '../icons';
import { MermaidDiagram, MermaidSourceDisclosure } from './MermaidDiagram';
import type { DerivedDiagramSurface, DiagramSurfaceSession } from './diagramWorkspace';
import type { AtlasScene, SceneEntity } from '../renderer/types';
import type { DynamicFlowArtifact } from '@okie/scene-compiler';

export type SemanticDiagramInteraction = {
  id: string;
  sequence: number;
  label: string;
  sourceId: string;
  targetId: string;
  semanticRelationId?: string;
  technology?: string;
  evidenceCount?: number;
};

export type SemanticDiagramPreview = {
  participants: SceneEntity[];
  interactions: SemanticDiagramInteraction[];
};

export function semanticDiagramPreview(
  scene: AtlasScene,
  surface: DerivedDiagramSurface,
  artifact?: DynamicFlowArtifact,
): SemanticDiagramPreview {
  if (artifact) {
    const participants = artifact.participants
      .map(item => scene.entities.find(entity => entity.id === item.id))
      .filter((entity): entity is SceneEntity => Boolean(entity));
    return {
      participants,
      interactions: artifact.interactions.map(interaction => ({
        id: interaction.id,
        sequence: interaction.sequence,
        label: interaction.label,
        sourceId: interaction.fromEntityId,
        targetId: interaction.toEntityId,
        semanticRelationId: interaction.semanticRelationId,
        ...(interaction.technology ? { technology: interaction.technology } : {}),
        evidenceCount: interaction.evidence.length,
      })),
    };
  }
  const entityIds = new Set(surface.entityIds);
  const participants = surface.entityIds
    .map(id => scene.entities.find(entity => entity.id === id))
    .filter((entity): entity is SceneEntity => Boolean(entity));
  const interactions = scene.relations
    .filter(relation => entityIds.has(relation.from) && entityIds.has(relation.to))
    .map((relation, index) => ({
      id: relation.id,
      sequence: index + 1,
      label: relation.label ?? relation.kindLabel ?? 'Interacts with',
      sourceId: relation.from,
      targetId: relation.to,
    }));
  return { participants, interactions };
}

type SemanticDiagramSurfaceProps = {
  scene: AtlasScene;
  surface: DerivedDiagramSurface;
  flowArtifact?: DynamicFlowArtifact;
  mermaidSource?: string;
  notationAdvisoryCount?: number;
  onSessionChange: (session: DiagramSurfaceSession) => void;
};

function surfaceLabel(kind: DerivedDiagramSurface['kind']) {
  if (kind === 'flow') return 'Dynamic flow';
  if (kind === 'mermaid') return 'Mermaid';
  return 'Code diagram';
}

export function SemanticDiagramSurface({
  scene,
  surface,
  flowArtifact,
  mermaidSource,
  notationAdvisoryCount = 0,
  onSessionChange,
}: SemanticDiagramSurfaceProps) {
  const preview = semanticDiagramPreview(scene, surface, flowArtifact);
  const byId = new Map(preview.participants.map(entity => [entity.id, entity]));
  const selectedId = surface.session.selectedElementId ?? preview.participants[0]?.id;
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const select = (entity: SceneEntity) => onSessionChange({
    ...surface.session,
    selectedElementId: entity.id,
    inspector: { open: true, tab: 'details', subjectId: entity.id },
  });

  return <section
    aria-label={`${surface.title} ${surfaceLabel(surface.kind)}`}
    className={`semantic-diagram-surface kind-${surface.kind}`}
    data-flow-artifact-id={flowArtifact?.id ?? ''}
    data-notation-advisories={notationAdvisoryCount}
    id="derived-diagram-content"
  >
    <header className="semantic-diagram-header">
      <div><span>{surfaceLabel(surface.kind)}</span><h1>{surface.title}</h1><p>{flowArtifact ? 'Evidence-backed ordered interactions compiled from the selected semantic scope.' : 'Structured from the active semantic neighbourhood without replacing the Main architecture scene.'}</p></div>
      <div className="semantic-diagram-summary"><strong>{preview.participants.length}</strong><span>participants</span><strong>{preview.interactions.length}</strong><span>interactions</span></div>
    </header>

    <div className={`semantic-diagram-readiness ${notationAdvisoryCount ? 'advisory' : 'ready'}`} role="status">
      <span>{notationAdvisoryCount ? `${notationAdvisoryCount} C4 notation ${notationAdvisoryCount === 1 ? 'advisory' : 'advisories'}` : 'C4 notation ready'}</span>
      <small>{flowArtifact ? `${flowArtifact.steps.length} ordered ${flowArtifact.steps.length === 1 ? 'step' : 'steps'} · semantic and evidence links retained` : 'Derived from the active architecture view'}</small>
    </div>

    <div className={`semantic-diagram-layout ${surface.session.inspector.open && selected ? 'has-inspector' : ''}`}>
      <div className="semantic-diagram-preview">
        {surface.kind === 'mermaid' && mermaidSource && <MermaidDiagram source={mermaidSource} title={`${surface.title} diagram`}/>}
        {surface.kind === 'mermaid' && !mermaidSource && <section className="semantic-mermaid-diagram semantic-mermaid-unavailable" role="alert"><strong>Diagram preview unavailable</strong><span>No Mermaid artifact was produced for this semantic scope. The structured outline remains available.</span></section>}

        <section aria-labelledby={`${surface.id}-participants`} className="semantic-participants">
          <h2 id={`${surface.id}-participants`}>Participants</h2>
          <div>{preview.participants.map((entity, index) => <button aria-pressed={entity.id === selectedId} className={entity.id === selectedId ? 'selected' : ''} key={entity.id} onClick={() => select(entity)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{entity.name}</strong><small>{entity.kindLabel ?? entity.kind}</small></button>)}</div>
        </section>

        <section aria-labelledby={`${surface.id}-interactions`} className="semantic-interactions">
          <h2 id={`${surface.id}-interactions`}>Interactions</h2>
          {preview.interactions.length ? <ol>{preview.interactions.map(interaction => <li data-semantic-relation-id={interaction.semanticRelationId ?? interaction.id} key={interaction.id}><span>{String(interaction.sequence).padStart(2, '0')}</span><div><strong>{interaction.label}</strong><small>{byId.get(interaction.sourceId)?.name ?? interaction.sourceId} <ArrowIcon size={12}/> {byId.get(interaction.targetId)?.name ?? interaction.targetId}{interaction.technology ? ` · ${interaction.technology}` : ''}{interaction.evidenceCount !== undefined ? ` · ${interaction.evidenceCount} evidence` : ''}</small></div></li>)}</ol> : <p>No explicit interactions connect the selected participants.</p>}
        </section>

        {surface.kind === 'mermaid' && mermaidSource && <MermaidSourceDisclosure source={mermaidSource}/>}
      </div>

      {surface.session.inspector.open && selected && <aside aria-label={`Diagram element details for ${selected.name}`} className="semantic-diagram-inspector">
        <header><span>Diagram element</span><button aria-label="Close diagram element details" onClick={() => onSessionChange({ ...surface.session, inspector: { ...surface.session.inspector, open: false } })}><CloseIcon size={15}/></button></header>
        <h2>{selected.name}</h2>
        <p>{selected.responsibility}</p>
        <dl><div><dt>Kind</dt><dd>{selected.kindLabel ?? selected.kind}</dd></div>{selected.technology && <div><dt>Technology</dt><dd>{selected.technology}</dd></div>}</dl>
        {selected.sourceRefs?.[0] && <div className="semantic-diagram-source"><FileIcon size={15}/><span><strong>{selected.sourceRefs[0].path.split('/').at(-1)}</strong><small>{selected.sourceRefs[0].path}</small></span></div>}
      </aside>}
    </div>
  </section>;
}
