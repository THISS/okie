import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceRepoLink, sourceRepoLinkPresentation } from './sourceRepoLink';

describe('CLA-329 source repository link', () => {
  it.each([
    ['https://github.com/pmndrs/zustand/tree/4f1c2a9', true],
    ['https://www.github.com/pmndrs/zustand', true],
    ['http://github.com/pmndrs/zustand', false],
    ['https://gist.github.com/x', false],
    ['https://github.com.evil.example/pmndrs/zustand', false],
    ['https://gitlab.com/group/project', false],
    ['not a url', false],
  ])('%s → github %s', (url, github) => {
    expect(sourceRepoLinkPresentation(url)).toEqual({ github, label: github ? 'View on GitHub' : 'Open source repository' });
  });

  it('renders the GitHub mark and label for GitHub, the code icon otherwise; test id kept', () => {
    const github = renderToStaticMarkup(<SourceRepoLink url="https://github.com/pmndrs/zustand"/>);
    expect(github).toContain('data-testid="open-source-repo"');
    expect(github).toContain('aria-label="View on GitHub"');
    expect(github).toContain('title="View on GitHub"');
    expect(github).toContain('fill="currentColor"');
    expect(github).toContain('aria-hidden="true"');
    const other = renderToStaticMarkup(<SourceRepoLink url="https://gitlab.com/group/project"/>);
    expect(other).toContain('aria-label="Open source repository"');
    expect(other).not.toContain('fill="currentColor"');
    expect(other).toContain('m8.5 7-5 5 5 5');
  });
});
