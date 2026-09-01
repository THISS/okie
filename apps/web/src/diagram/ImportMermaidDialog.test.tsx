import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportMermaidDialog } from './ImportMermaidDialog';

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('ImportMermaidDialog', () => {
  it('renders paste and open-file controls when open', () => {
    const markup = render(createElement(ImportMermaidDialog, {
      open: true,
      source: 'flowchart TD\n  A --> B',
      onClose: () => undefined,
      onImport: () => undefined,
      onSourceChange: () => undefined,
    }));
    expect(markup).toContain('data-testid="import-mermaid-dialog"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('Mermaid source');
    expect(markup).toContain('Open file');
    expect(markup).toContain('Import onto atlas');
    expect(markup).toContain('type="file"');
    expect(markup).not.toContain('semantic-mermaid-svg');
    expect(markup).not.toContain('mermaid.core');
  });

  it('shows a parse error without implying the atlas changed', () => {
    const markup = render(createElement(ImportMermaidDialog, {
      error: 'This is not valid Mermaid. The atlas is unchanged.',
      open: true,
      source: 'nope',
      onClose: () => undefined,
      onImport: () => undefined,
      onSourceChange: () => undefined,
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('atlas is unchanged');
  });

  it('renders nothing when closed', () => {
    const markup = render(createElement(ImportMermaidDialog, {
      open: false,
      source: '',
      onClose: () => undefined,
      onImport: () => undefined,
      onSourceChange: () => undefined,
    }));
    expect(markup).toBe('');
  });
});
