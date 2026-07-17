import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@okie/theme/tokens.css';
import './app.css';
import { readDemoQuery } from './renderer/query';
import { setActiveScanFixture } from './renderer/fixtureBundle';
import { loadScanFixture, ScanFixtureError, type ScanFixture } from './renderer/scanFixture';

const root = createRoot(document.getElementById('root')!);

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

async function boot() {
  // A scanned fixture is fetched, validated and compiled BEFORE App is imported,
  // so App reads the compiled scene/story synchronously (like the golden fixture).
  if (readDemoQuery(window.location.search).fixture === 'scan') {
    let fixture: ScanFixture;
    try {
      fixture = await loadScanFixture();
    } catch (error) {
      root.render(<StrictMode><ScanErrorScreen error={error} /></StrictMode>);
      return;
    }
    setActiveScanFixture(fixture);
  }
  const { App } = await import('./App');
  root.render(<StrictMode><App /></StrictMode>);
}

void boot();
