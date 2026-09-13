import { describe, expect, it } from 'vitest';
import { operatorDiagramSource } from './OperatorExplanationContext';

describe('operator explanation diagrams', () => {
  it('uses entity names and strips Mermaid syntax from provider labels', () => {
    const source = operatorDiagramSource({ scopeId: 'api', name: 'API', state: 'accepted', explanation: { summary: 'x', evidence: [], diagram: { nodes: ['api', 'db'], edges: [{ from: 'api', to: 'db', label: 'reads | click evil' }] } } }, new Map([['api', 'Public API'], ['db', 'Database']]));
    expect(source).toContain('Public API');
    expect(source).toContain('Database');
    expect(source).toContain('reads click evil');
    expect(source).not.toContain('n0 -->|reads | click evil|');
  });
});
