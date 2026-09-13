import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperatorExplanationContext, operatorDiagramSource } from './OperatorExplanationContext';

describe('operator explanation diagrams', () => {
  it('uses entity names and strips Mermaid syntax from provider labels', () => {
    const source = operatorDiagramSource({ scopeId: 'api', name: 'API', state: 'accepted', explanation: { summary: 'x', evidence: [], diagram: { nodes: ['api', 'db'], edges: [{ from: 'api', to: 'db', label: 'reads | click evil' }] } } }, new Map([['api', 'Public API'], ['db', 'Database']]));
    expect(source).toContain('Public API');
    expect(source).toContain('Database');
    expect(source).toContain('reads click evil');
    expect(source).not.toContain('n0 -->|reads | click evil|');
  });
  it('renders the accepted summary for the overview inspector while leaving missing explanations empty', () => {
    const scope = { scopeId: 'api', entityId: 'api', name: 'API', state: 'accepted' as const, explanation: { summary: 'Accepts public requests.', roleWithinParent: 'Gateway', evidence: [] } };
    expect(renderToStaticMarkup(createElement(OperatorExplanationContext, { scope, entityNames: new Map([['api', 'Public API']]) }))).toContain('Accepts public requests.');
    expect(renderToStaticMarkup(createElement(OperatorExplanationContext, { scope: undefined, entityNames: new Map() }))).toBe('');
  });
});
