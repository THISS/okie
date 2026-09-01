import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

describe('published Vite host default (CLA-17)', () => {
  it('does not bind 0.0.0.0 in package scripts', () => {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).not.toMatch(/0\.0\.0\.0/);
    }
    expect(pkg.scripts.dev).toMatch(/^vite\b/);
    expect(pkg.scripts.dev).not.toMatch(/--host/);
  });

  it('pins the Vite server and preview to localhost', () => {
    expect(viteConfig).not.toMatch(/0\.0\.0\.0/);
    expect(viteConfig).toMatch(/host:\s*['"]localhost['"]/);
  });

  it('is an SPA so /r/<owner>/<repo> share URLs serve the shell (CLA-30)', () => {
    expect(viteConfig).toMatch(/appType:\s*['"]spa['"]/);
    const redirects = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8');
    expect(redirects).toMatch(/\/r\/\*\s+\/index\.html\s+200/);
    expect(redirects).toMatch(/\/new\s+\/index\.html\s+200/);
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(vercel.rewrites).toEqual(expect.arrayContaining([
      { source: '/oembed', destination: '/api/oembed' },
      { source: '/r/:path*', destination: '/index.html' },
      { source: '/new', destination: '/index.html' },
    ]));
  });
});
