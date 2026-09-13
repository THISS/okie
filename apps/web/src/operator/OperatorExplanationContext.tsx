import { MermaidDiagram } from '../diagram/MermaidDiagram';
import type { OperatorScope } from './api';

export function operatorDiagramSource(scope: OperatorScope, names: ReadonlyMap<string, string>): string | undefined {
  const diagram = scope.explanation?.diagram;
  if (!diagram?.nodes.length) return undefined;
  const ids = new Map(diagram.nodes.map((id, index) => [id, `n${index}`]));
  const safe = (value: string) => value.replace(/["\[\]{}|<>`]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
  return ['flowchart LR', ...diagram.nodes.map((id, index) => `  n${index}["${safe(names.get(id) ?? 'Architecture entity')}"]`), ...diagram.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => `  ${ids.get(edge.from)} -->${edge.label ? `|${safe(edge.label)}|` : ''} ${ids.get(edge.to)}`)].join('\n');
}

export function OperatorExplanationContext({ scope, entityNames }: { scope?: OperatorScope; entityNames: ReadonlyMap<string, string> }) {
  if (!scope?.explanation) return null;
  const explanation = scope.explanation; const source = operatorDiagramSource(scope, entityNames);
  return <section className="detail-section operator-explanation-context" data-testid="operator-explanation-context">
    <div className="section-title"><h3>Accepted operator explanation</h3><span>{scope.stale ? 'Stale' : 'Pinned'}</span></div>
    <p>{explanation.summary}</p>
    {explanation.roleWithinParent && <p><strong>Role within parent:</strong> {explanation.roleWithinParent}</p>}
    {explanation.interactions?.length ? <><h4>Important interactions</h4><ul>{explanation.interactions.map(value => <li key={value}>{value}</li>)}</ul></> : null}
    <h4>Evidence</h4><ul>{explanation.evidence.map((evidence, index) => <li key={index}>{evidence.path ? `${evidence.path}${evidence.startLine ? `:${evidence.startLine}${evidence.endLine ? `-${evidence.endLine}` : ''}` : ''}` : entityNames.get(evidence.entityId ?? '') ?? 'Captured architecture evidence'}</li>)}</ul>
    {source && <MermaidDiagram compact source={source} title={`${scope.name} interactions`}/>} {(scope.diagramError ?? explanation.diagramError) && <p className="detail-muted">{scope.diagramError ?? explanation.diagramError}</p>}
  </section>;
}
