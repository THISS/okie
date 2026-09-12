import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DiagramActionHelp } from './DiagramActionHelp';

it('renders a named button linked to tooltip content outside native closed disclosure', () => {
  const markup = renderToStaticMarkup(<DiagramActionHelp label="About dependencies">Captured unordered relationships.</DiagramActionHelp>);
  expect(markup).toContain('aria-label="About dependencies"');
  expect(markup).toContain('aria-expanded="false"');
  const controls = markup.match(/aria-controls="([^"]+)"/)![1];
  expect(markup).toContain(`aria-describedby="${controls}"`);
  expect(markup).toContain(`id="${controls}" role="tooltip"`);
  expect(markup).toContain('Captured unordered relationships.');
  expect(markup).not.toContain('<details');
});
