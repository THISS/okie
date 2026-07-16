import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RelationshipAuthoringOverlay } from './RelationshipAuthoringOverlay';

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

describe('relationship authoring overlay', () => {
  it('renders a route drag with one live draft layer and no duplicate committed dashed guide', () => {
    const markup = renderToStaticMarkup(<RelationshipAuthoringOverlay
      boundsByEntityId={{}}
      camera={{ x: 0, y: 0, zoom: 1 }}
      draft={{
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 40, y: 20 }],
        safe: true,
      }}
      portEntityIds={[]}
      viewport={{ width: 100, height: 100 }}
    />);

    expect(markup).not.toContain('data-overlay-layer="committed"');
    expect(markup).not.toContain('data-testid="authoring-selected-route"');
    expect(markup.match(/data-overlay-layer="draft"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="relationship-route-preview"/g)).toHaveLength(1);
  });

  it('renders the live draft as the final SVG layer above a distinct committed route', () => {
    const markup = renderToStaticMarkup(<RelationshipAuthoringOverlay
      boundsByEntityId={{ source: { x: -10, y: -10, width: 20, height: 20 } }}
      camera={{ x: 0, y: 0, zoom: 1 }}
      draft={{
        points: [{ x: 10, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 50, y: 20 }],
        safe: true,
      }}
      portEntityIds={['source']}
      selectedRoute={[{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 50, y: 10 }]}
      viewport={{ width: 100, height: 100 }}
    />);

    const committedLayer = markup.indexOf('data-overlay-layer="committed"');
    const portLayer = markup.indexOf('data-overlay-layer="ports"');
    const draftLayer = markup.indexOf('data-overlay-layer="draft"');
    const halo = markup.indexOf('class="authoring-route-preview-halo"');
    const preview = markup.indexOf('data-testid="relationship-route-preview"');

    expect(markup).toContain('data-testid="authoring-selected-route"');
    expect(markup).toContain('class="authoring-draft-layer safe"');
    expect(markup).toContain('data-draft-state="safe"');
    expect(markup).toContain('class="authoring-route-preview safe"');
    expect(markup).toContain('data-safe="true"');
    expect(committedLayer).toBeGreaterThan(0);
    expect(portLayer).toBeGreaterThan(committedLayer);
    expect(draftLayer).toBeGreaterThan(portLayer);
    expect(halo).toBeGreaterThan(draftLayer);
    expect(preview).toBeGreaterThan(halo);
  });

  it('keeps the overlay above the renderer and gives the draft a contrasting dotted stroke and halo', () => {
    const renderer = declarations(css, '.atlas-renderer-host');
    const overlay = declarations(css, '.relationship-authoring-overlay');
    const halo = declarations(css, '.authoring-route-preview-halo');
    const preview = declarations(css, '.authoring-route-preview');
    const blocked = declarations(css, '.authoring-route-preview.blocked');

    expect(renderer).toContain('z-index: 0');
    expect(overlay).toContain('z-index: 6');
    expect(overlay).toContain('isolation: isolate');
    expect(halo).toContain('stroke-width: 7');
    expect(preview).toContain('stroke: var(--atlas-orange)');
    expect(preview).toContain('stroke-width: 3.5');
    expect(preview).toContain('stroke-dasharray: 2 6');
    expect(blocked).toContain('stroke: var(--atlas-danger)');
  });
});
