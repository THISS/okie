import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@okie/theme/tokens.css';
import './app.css';
import { ASPECT_PRESET_TARGET } from '@okie/architecture';
import { hostedAtlasBootPlan } from './hostedAtlas';
import { installPublicAtlasOembedDiscovery } from './oembed';
import { readDemoQuery } from './renderer/query';
import { parseAppRoute } from './renderer/route';
import { setActiveScanFixture } from './renderer/fixtureBundle';
import { registerWebMcpFoundation } from './webmcp';
import {
  availableScanRepoSlugs,
  fetchScanTrioLoader,
  loadScanFixture,
  ScanFixtureError,
  type ScanFixture,
  type ScanTrioLoader,
} from './renderer/scanFixture';

const root = createRoot(document.getElementById('root')!);

/**
 * Deterministic per-session aspect target for scan mode (task #30): the device
 * orientation at bootstrap picks one discrete preset ONCE. It is a compile input,
 * NOT the live viewport, so the compiled scene stays deterministic and shareable —
 * re-orienting the device is an explicit reload/recompile, not a continuous reflow.
 */
function bootstrapScanAspect(): number {
  const portrait = window.matchMedia?.('(orientation: portrait)')?.matches
    ?? window.innerHeight > window.innerWidth;
  return portrait ? ASPECT_PRESET_TARGET.portrait : ASPECT_PRESET_TARGET.landscape;
}

function ScanErrorScreen({ error }: { error: unknown }) {
  const issues = error instanceof ScanFixtureError ? error.issues : [];
  const message = error instanceof Error ? error.message : String(error);
  return <main role="alert" style={{ maxWidth: '720px', margin: '0 auto', padding: '4rem 1.5rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif' }}>
    <h1 style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>Scanned snapshot could not be loaded</h1>
    <p style={{ color: '#b7c3c0' }}>The <code>fixtures/scan/</code> trio failed to load or validate. Nothing is rendered rather than showing an invalid snapshot.</p>
    {issues.length
      ? <ul style={{ lineHeight: 1.8 }}>{issues.map((issue, index) => <li key={index}>{issue.path ? <><code style={{ color: '#d9ff70' }}>{issue.path}</code>{' — '}</> : null}{issue.message}</li>)}</ul>
      : <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9b9b' }}>{message}</pre>}
    <p style={{ color: '#79dfd4', marginTop: '1.5rem' }}>Regenerate with <code>okie-scan</code>, or load the <a href="?fixture=okie" style={{ color: '#79dfd4' }}>demo</a>.</p>
  </main>;
}

async function tryBootScanFixture(
  load: ScanTrioLoader | undefined,
  slug: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const fixture: ScanFixture = await loadScanFixture(load, { targetAspect: bootstrapScanAspect() }, slug);
    setActiveScanFixture(fixture);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function bootScanFixture(load: ScanTrioLoader | undefined, slug: string | undefined): Promise<boolean> {
  const result = await tryBootScanFixture(load, slug);
  if (!result.ok) {
    root.render(<StrictMode><ScanErrorScreen error={result.error} /></StrictMode>);
    return false;
  }
  return true;
}

async function boot() {
  // WebMCP is progressive enhancement (CLA-40). Missing APIs are a silent no-op.
  void registerWebMcpFoundation();
  // A scanned fixture is fetched, validated and compiled BEFORE App is imported,
  // so App reads the compiled scene/story synchronously (like the golden fixture).
  //
  // Selection, in order:
  //   /new                       → the paste-a-repo landing (no atlas machinery)
  //   /r/<owner>/<repo>          → public share URL (no login). Published trio
  //                                via runtime fetch; THISS/okie also falls back
  //                                through the bundled self-scan to the golden demo.
  //   ?fixture=scan[:<slug>]     → the R3a query form (bundled glob; runtime-fetch
  //                                fallback for a slug published after this build)
  const route = parseAppRoute(window.location.pathname);
  if (route.kind === 'landing') {
    const { ScanLandingScreen } = await import('./scanLanding');
    root.render(<StrictMode><ScanLandingScreen /></StrictMode>);
    return;
  }
  if (route.kind === 'repo') {
    // Public share URL (no login). oEmbed discovery points docs sites at /oembed.
    installPublicAtlasOembedDiscovery(window.location.href);
    const plan = hostedAtlasBootPlan(route, { bundledSlugs: availableScanRepoSlugs() });
    let lastError: unknown;
    let atlasReady = false;
    for (const step of plan) {
      if (step.kind === 'golden') {
        atlasReady = true;
        break;
      }
      const load = step.kind === 'fetch' ? fetchScanTrioLoader(step.slug) : undefined;
      const result = await tryBootScanFixture(load, step.slug);
      if (result.ok) {
        atlasReady = true;
        break;
      }
      lastError = result.error;
    }
    if (!atlasReady) {
      root.render(<StrictMode><ScanErrorScreen error={lastError} /></StrictMode>);
      return;
    }
  } else {
    const query = readDemoQuery(window.location.search);
    if (query.fixture === 'scan') {
      const bundled = query.scanRepo === undefined || availableScanRepoSlugs().includes(query.scanRepo);
      const load = bundled ? undefined : fetchScanTrioLoader(query.scanRepo);
      if (!await bootScanFixture(load, query.scanRepo)) return;
    }
  }
  const { App } = await import('./App');
  root.render(<StrictMode><App /></StrictMode>);
}

void boot();
