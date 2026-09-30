import { CodeIcon, GitHubIcon } from './icons';

/**
 * CLA-329: the header's source-repository link. A GitHub repository shows the GitHub mark and says so ("View on
 * GitHub"); anything else keeps the generic code icon. The `</>` glyph now belongs to the embed button.
 */
export type SourceRepoLinkPresentation = { github: boolean; label: string };

export const GITHUB_LINK_LABEL = 'View on GitHub';
export const SOURCE_REPO_LINK_LABEL = 'Open source repository';

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

export function sourceRepoLinkPresentation(url: string): SourceRepoLinkPresentation {
  let github = false;
  try {
    const parsed = new URL(url);
    github = parsed.protocol === 'https:' && GITHUB_HOSTS.has(parsed.hostname);
  } catch {
    github = false;
  }
  return { github, label: github ? GITHUB_LINK_LABEL : SOURCE_REPO_LINK_LABEL };
}

/** The header link: GitHub mark + "View on GitHub" for GitHub, else the code icon + "Open source repository". */
export function SourceRepoLink({ url }: { url: string }) {
  const { github, label } = sourceRepoLinkPresentation(url);
  return <a aria-label={label} className="icon-button" data-testid="open-source-repo" href={url} rel="noreferrer" target="_blank" title={label}>{github ? <GitHubIcon/> : <CodeIcon/>}</a>;
}
