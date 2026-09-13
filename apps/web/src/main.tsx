import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@okie/theme/tokens.css';
import './app.css';
import { ASPECT_PRESET_TARGET, parsePortableAtlas, type PortableAtlas } from '@okie/architecture';
import { hostedAtlasBootPlan } from './hostedAtlas';
import { installPublicAtlasOembedDiscovery } from './oembed';
import { readDemoQuery } from './renderer/query';
import { parseAppRoute } from './renderer/route';
import { setActiveScanFixture } from './renderer/fixtureBundle';
import { compileScanFixture } from './renderer/scanFixture';
import { PortableAtlasControls } from './portable/PortableAtlasControls';
import { PortableAtlasOpenScreen } from './portable/PortableAtlasOpenScreen';
import { isPortableMode, portableNavigationDiffers, portableReloadPath, setActivePortableAtlas } from './portable/runtime';
import { createIndexedDbPortableStore, createPortablePersistence, portableStorageKey } from './portable/storage';
import { registerWebMcpFoundation } from './webmcp';
import { readPortableFile, rememberPortableSession, forgetPortableSession } from './portable/session';
import { OperatorWorkspace } from './operator/OperatorWorkspace';
import {
  availableScanRepoSlugs,
  fetchScanNeighborhoodHost,
  fetchScanTrioLoader,
  loadScanFixture,
  loadScanNeighborhoodFixtureFromSearch,
  ScanFixtureError,
  type ScanFixture,
  type ScanTrioLoader,
} from './renderer/scanFixture';

const root = createRoot(document.getElementById('root')!);
let indexedDb: IDBFactory | undefined;
try { indexedDb = window.indexedDB; } catch { /* Browser policy may deny even reading the factory. */ }
let portablePersistence = createPortablePersistence(createIndexedDbPortableStore(indexedDb, `active-v1:${new URL('./', window.location.href).pathname}`));

/**
 * Published scan / neighborhood compile aspect (CLA-96). Landscape ~1.6 is a
 * compile input, not the live viewport, so `/r/…` L1 Fit is a shareable
 * context map. Portrait reflow is not this slice; golden/demo omit targetAspect.
 */
function bootstrapScanAspect(): number {
  return ASPECT_PRESET_TARGET.landscape;
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

async function tryBootNeighborhoodFixture(
  slug: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const fixture: ScanFixture = await loadScanNeighborhoodFixtureFromSearch(
      fetchScanNeighborhoodHost(slug),
      window.location.search,
      { targetAspect: bootstrapScanAspect() },
    );
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

function portableMarkerEnabled(): boolean {
  return document.querySelector('meta[name="okie-portable"]')?.getAttribute('content') === 'true';
}

function preparePortableAtlas(bundle: PortableAtlas): { fixture?: ScanFixture; error?: string } {
  try {
    const fixture = compileScanFixture({
      snapshot: bundle.snapshot,
      view: bundle.view,
      story: bundle.story,
      stories: { stories: bundle.stories },
    }, { targetAspect: bootstrapScanAspect() });
    return { fixture };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

let portableMountSequence = 0;

async function mountPortableAtlas(bundle: PortableAtlas, fixture: ScanFixture, notice?: string, resetNavigation = true): Promise<void> {
  const { App, refreshAppScanFixture } = await import('./App');
  // Unmount first: no old App effect may observe the replacement's module state.
  flushSync(() => root.render(null));
  setActivePortableAtlas(bundle);
  setActiveScanFixture(fixture);
  refreshAppScanFixture();
  if (resetNavigation || portableNavigationDiffers(window.location.search, bundle)) {
    window.history.replaceState(null, '', portableReloadPath({ pathname: window.location.pathname, hash: '' }));
  }
  portableMountSequence += 1;
  root.render(<StrictMode key={portableMountSequence}>
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><App /></div>
    <PortableAtlasControls bundle={bundle} notice={notice}
      onReplace={openPortableFile}
      onForget={async () => {
        const message = await forgetPortableSession(portablePersistence);
        flushSync(() => root.render(null));
        setActivePortableAtlas(undefined);
        setActiveScanFixture(undefined);
        refreshAppScanFixture();
        window.history.replaceState(null, '', portableReloadPath({ pathname: window.location.pathname, hash: '' }, true));
        showPortablePicker(message);
        return { ok: true };
      }}
    />
    </div>
  </StrictMode>);
}

/** Operator previews deliberately use the same compiled atlas and App as a portable
 * bundle, but never place a draft in the user's portable IndexedDB session. */
async function mountOperatorDraftPreview(draftRevisionId: string): Promise<void> {
  const { operatorApi } = await import('./operator/api');
  const raw = await operatorApi.bundle(draftRevisionId);
  const bundle = parsePortableAtlas(JSON.stringify(raw));
  const prepared = preparePortableAtlas(bundle);
  if (!prepared.fixture) throw new Error(prepared.error ?? 'Draft bundle could not be compiled.');
  const { App, refreshAppScanFixture } = await import('./App');
  flushSync(() => root.render(null));
  setActivePortableAtlas(bundle);
  setActiveScanFixture(prepared.fixture);
  refreshAppScanFixture();
  root.render(<StrictMode><div className="operator-preview-shell"><header><span>Operator draft preview · pinned revision {draftRevisionId}</span><button onClick={() => { setActivePortableAtlas(undefined); setActiveScanFixture(undefined); refreshAppScanFixture(); void mountOperatorWorkspace(); }}>Return to review</button></header><div><App /></div></div></StrictMode>);
}

async function mountOperatorWorkspace(): Promise<void> {
  flushSync(() => root.render(null));
  root.render(<StrictMode><OperatorWorkspace onPreview={mountOperatorDraftPreview}/></StrictMode>);
}

async function openPortableFile(file: File): Promise<{ ok: true } | { ok: false; message: string }> {
  const loaded = await readPortableFile(file);
  if (!loaded.bundle) return { ok: false, message: loaded.error ?? 'Could not read this atlas.' };
  const prepared = preparePortableAtlas(loaded.bundle);
  if (!prepared.fixture) return { ok: false, message: prepared.error ?? 'Could not compile this atlas.' };
  const notice = await rememberPortableSession(portablePersistence, loaded.bundle);
  await mountPortableAtlas(loaded.bundle, prepared.fixture, notice);
  return { ok: true };
}

function showPortablePicker(error?: string): void {
  root.render(<StrictMode><PortableAtlasOpenScreen error={error} onOpen={openPortableFile} /></StrictMode>);
}

async function bootPortableAtlas(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  let unavailableMessage: string | undefined;
  let packaged: PortableAtlas | undefined;
  // Resolve this site's package before consulting remembered imports. Each static
  // folder and each deployed artifact version owns a separate convenience slot.
  try {
    const response = await fetch('./atlas.okie.json');
    if (response.ok) {
      const text = await response.text();
      packaged = parsePortableAtlas(text);
      try {
        const key = await portableStorageKey(window.location.href, text);
        portablePersistence = createPortablePersistence(createIndexedDbPortableStore(indexedDb, key));
      } catch {
        // Without a reliable package identity, retain session-only operation.
        portablePersistence = createPortablePersistence(createIndexedDbPortableStore(undefined));
      }
    } else if (response.status !== 404) {
      unavailableMessage = `Packaged atlas is unavailable (${response.status}).`;
    }
  } catch (error) {
    unavailableMessage = error instanceof Error ? error.message : String(error);
  }
  if (params.get('open') !== '1') {
    const remembered = await portablePersistence.restore();
    if (remembered.bundle) {
      const prepared = preparePortableAtlas(remembered.bundle);
      if (prepared.fixture) {
        await mountPortableAtlas(remembered.bundle, prepared.fixture, undefined, false);
        return;
      }
      unavailableMessage = `The saved local atlas could not be compiled: ${prepared.error}`;
    } else if (remembered.error) {
      unavailableMessage ??= remembered.error;
    }
    if (packaged) {
      const prepared = preparePortableAtlas(packaged);
      if (prepared.fixture) {
        const notice = await rememberPortableSession(portablePersistence, packaged);
        await mountPortableAtlas(packaged, prepared.fixture, notice, false);
        return;
      }
      unavailableMessage = prepared.error;
    }
  }
  showPortablePicker(unavailableMessage);
}

async function boot() {
  // WebMCP is progressive enhancement (CLA-40). Missing APIs are a silent no-op.
  void registerWebMcpFoundation();
  if (isPortableMode(window.location.search, portableMarkerEnabled())) {
    await bootPortableAtlas();
    return;
  }
  if (window.location.pathname === '/operator') {
    await mountOperatorWorkspace();
    return;
  }
  // A scanned fixture is fetched, validated and compiled BEFORE App is imported,
  // so App reads the compiled scene/story synchronously (like the golden fixture).
  //
  // Selection, in order:
  //   /new                       → the paste-a-repo landing (no atlas machinery)
  //   /r/<owner>/<repo>          → public share URL (no login). Neighborhood
  //                                packet via runtime fetch (CLA-73); THISS/okie
  //                                also falls back through the bundled self-scan
  //                                to the golden demo.
  //   ?fixture=scan[:<slug>]     → neighborhood fetch first, then the R3a glob
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
      if (step.kind === 'fetch') {
        const neighborhood = await tryBootNeighborhoodFixture(step.slug);
        if (neighborhood.ok) {
          atlasReady = true;
          break;
        }
        lastError = neighborhood.error;
        continue;
      }
      const result = await tryBootScanFixture(undefined, step.slug);
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
      const neighborhood = await tryBootNeighborhoodFixture(query.scanRepo);
      if (!neighborhood.ok) {
        const bundled = query.scanRepo === undefined || availableScanRepoSlugs().includes(query.scanRepo);
        const load = bundled ? undefined : fetchScanTrioLoader(query.scanRepo);
        if (!await bootScanFixture(load, query.scanRepo)) return;
      }
    }
  }
  const { App } = await import('./App');
  root.render(<StrictMode><App /></StrictMode>);
}

void boot();
