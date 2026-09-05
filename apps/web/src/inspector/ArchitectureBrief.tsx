import { useEffect, useState } from 'react';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import type { ArchitectureBrief } from './architectureBrief';

type CopyState = 'idle' | 'copied' | 'error';

export type ArchitectureBriefViewProps = {
  brief: ArchitectureBrief;
  honestyChip?: string;
  containerAvailable: (id: string) => boolean;
  onOpenContainer: (id: string) => void;
};

export function ArchitectureBriefView({
  brief,
  honestyChip,
  containerAvailable,
  onOpenContainer,
}: ArchitectureBriefViewProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => setCopyState('idle'), [brief.markdown]);

  const copyMarkdown = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(brief.markdown);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  return <article
    aria-labelledby="architecture-brief-title"
    className="inspector-presentation architecture-brief"
    data-brief-summary-kind={brief.systemSummaryKind}
    data-testid="architecture-brief"
  >
    <header className="brief-kicker">
      <div className="entity-kicker">
        <span>Architecture brief</span>
        {honestyChip && brief.systemSummaryKind === 'structural'
          ? <small className="enrichment-honesty-chip" data-testid="architecture-brief-honesty">{honestyChip}</small>
          : null}
        <small className="provenance-badge">Same snapshot</small>
      </div>
      <div className="brief-copy-actions">
        <span aria-live="polite">{copyState === 'copied' ? 'Markdown copied' : copyState === 'error' ? 'Copy unavailable' : 'Deterministic markdown'}</span>
        <button data-testid="architecture-brief-copy" onClick={() => void copyMarkdown()} type="button">
          {copyState === 'copied' ? 'Copied' : 'Copy markdown'}
        </button>
      </div>
    </header>

    <div className="brief-prose">
      <h1 id="architecture-brief-title">{brief.systemName}</h1>
      <p data-architecture-brief-system-summary="">{brief.systemSummary}</p>

      <section data-testid="architecture-brief-system">
        <h2>System</h2>
        {brief.worldSentence ? <p>{brief.worldSentence}</p> : null}
        <div data-testid="architecture-brief-context-mermaid">
          <MermaidDiagram compact source={brief.contextMermaid} title={brief.contextMermaidTitle}/>
        </div>
        {brief.graphOmittedCount > 0
          ? <p className="empty-inspector-section" data-brief-omitted-nodes={brief.graphOmittedCount}>
            Diagram shows {brief.graphNodeCount} of {brief.graphNodeCount + brief.graphOmittedCount} nodes.
          </p>
          : null}
      </section>

      <section data-testid="architecture-brief-containers">
        <h2>Containers</h2>
        <p>{brief.containerIntro}</p>
        {brief.containers.length === 0
          ? <p className="empty-inspector-section">No containers are in this snapshot neighborhood.</p>
          : brief.containers.map(container => {
            const available = containerAvailable(container.id);
            return <section data-brief-container-id={container.id} key={container.id}>
              <h3>
                <button
                  disabled={!available}
                  onClick={() => available && onOpenContainer(container.id)}
                  type="button"
                >
                  {container.name}
                </button>
              </h3>
              <p>{container.summary ?? `${container.name} is a ${container.kindLabel}.`}</p>
              {container.technology?.length
                ? <p className="brief-technology">Technology: {container.technology.join(' · ')}.</p>
                : null}
            </section>;
          })}
        {brief.omittedContainerCount > 0
          ? <p className="empty-inspector-section" data-brief-omitted-containers={brief.omittedContainerCount}>
            {brief.containers.length} of {brief.containerCount} containers are loaded in this neighborhood.
          </p>
          : null}
      </section>

      <section data-testid="architecture-brief-flows">
        <h2>Key flows</h2>
        {brief.flowsMermaid
          ? <div data-testid="architecture-brief-flows-mermaid">
            <MermaidDiagram compact source={brief.flowsMermaid} title={brief.flowsMermaidTitle}/>
          </div>
          : null}
        {brief.flows.length === 0
          ? <p className="empty-inspector-section">No key flows are in this snapshot neighborhood.</p>
          : <ul>{brief.flows.map(flow => (
            <li data-brief-flow-id={flow.id} key={flow.id}>
              <strong>{flow.fromName}</strong> {flow.label} <strong>{flow.toName}</strong>
            </li>
          ))}</ul>}
        {brief.omittedFlowCount > 0
          ? <p className="empty-inspector-section" data-brief-omitted-flows={brief.omittedFlowCount}>
            List shows {brief.flows.length} of {brief.flows.length + brief.omittedFlowCount} flows.
          </p>
          : null}
      </section>
    </div>
  </article>;
}
