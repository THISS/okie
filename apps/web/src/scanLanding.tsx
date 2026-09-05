import { useEffect, useRef, useState, type FormEvent } from 'react';
import { enrichmentStageDetail, scanEntityCountCopy, type PublicEnrichment } from './scanJobEnrichment';
import {
  bindScanLandingActions,
  publicScanFetchInit,
  registerWebMcpLandingTools,
  startPublicScanResultFromHttp,
  type StartPublicScanResult,
} from './webmcp';

/**
 * The paste-a-repo landing (embed-hosting v2 self-serve): a GitHub URL goes in,
 * a scan job fires on the worker, and the moment the DETERMINISTIC atlas is
 * published the user is sent to /r/<owner>/<repo> — enrichment (AI descriptions)
 * keeps running server-side and republishes in place. Rendered pre-App at /new,
 * so it stays a tiny standalone surface with no atlas machinery loaded.
 */

type PublicJob = {
  id: string;
  slug: string;
  owner: string;
  repo: string;
  ref?: string;
  stage: 'queued' | 'scanning' | 'publishing' | 'enriching' | 'complete' | 'failed';
  atlasReady: boolean;
  commitSha?: string;
  entityCount?: number;
  relationCount?: number;
  enrichment: PublicEnrichment;
  error?: string;
  atlasPath: string;
};

type ManifestRepo = { slug: string; commitSha: string; entityCount: number };

const page: React.CSSProperties = {
  maxWidth: '680px',
  margin: '0 auto',
  padding: '4.5rem 1.5rem',
  color: '#eef4f2',
  fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif',
};
const mutedStyle: React.CSSProperties = { color: '#b7c3c0', lineHeight: 1.6 };
const cardStyle: React.CSSProperties = {
  border: '1px solid #2a3a37',
  borderRadius: '12px',
  padding: '1.25rem 1.5rem',
  marginTop: '1.5rem',
  background: 'rgba(255,255,255,0.02)',
};

const STAGE_LABELS: Array<{ key: PublicJob['stage'] | 'done'; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'scanning', label: 'Scanning the repository' },
  { key: 'publishing', label: 'Publishing the atlas' },
  { key: 'enriching', label: 'Writing AI descriptions' },
  { key: 'complete', label: 'Done' },
];

function atlasHrefForSlug(slug: string): string | undefined {
  const [owner, repo] = slug.split('__');
  return owner && repo ? `/r/${owner}/${repo}` : undefined;
}

type AuthView = {
  authenticated: boolean;
  login?: string;
  source?: string;
  loginPath: string;
  logoutPath: string;
  oauthConfigured: boolean;
  testLoginPath?: string;
  installPath?: string;
};

export function ScanLandingScreen() {
  const [input, setInput] = useState('');
  const [job, setJob] = useState<PublicJob | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [published, setPublished] = useState<ManifestRepo[]>([]);
  const [auth, setAuth] = useState<AuthView | undefined>();
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    void fetch('/api/auth/me', { credentials: 'include' })
      .then(response => (response.ok ? response.json() : undefined))
      .then((body: AuthView | undefined) => {
        if (body) setAuth(body);
      })
      .catch(() => {});
    return () => {
      if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    void fetch('/scan/index.json')
      .then(response => (response.ok ? response.json() : undefined))
      .then((manifest: { repos?: ManifestRepo[] } | undefined) => {
        if (manifest?.repos) setPublished(manifest.repos);
      })
      .catch(() => {});
  }, [job?.atlasReady]);

  const submitRepoRef = useRef<(url: string) => Promise<StartPublicScanResult>>(
    async () => startPublicScanResultFromHttp(0, {}),
  );

  useEffect(() => {
    const controller = new AbortController();
    const unbind = bindScanLandingActions({
      fillRepoInput: setInput,
      submitScan: url => submitRepoRef.current(url),
      openAtlas: atlasPath => {
        window.location.assign(atlasPath);
      },
    });
    void registerWebMcpLandingTools(globalThis, { signal: controller.signal });
    return () => {
      controller.abort();
      unbind();
    };
  }, []);

  function watchJob(id: string) {
    if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void fetch(`/api/scans/${encodeURIComponent(id)}`, { credentials: 'include' })
        .then(async response => {
          if (!response.ok) throw new Error(`status ${response.status}`);
          const body = (await response.json()) as { job: PublicJob };
          setJob(body.job);
          if (body.job.stage === 'complete' || body.job.stage === 'failed') {
            if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
            pollRef.current = undefined;
          }
        })
        .catch(() => {});
    }, 1500);
  }

  async function submitRepo(url: string): Promise<StartPublicScanResult> {
    setInput(url);
    setError(undefined);
    setSubmitting(true);
    try {
      const response = await fetch('/api/scans', publicScanFetchInit(url));
      const body = (await response.json()) as { job?: PublicJob; error?: string };
      const toolResult = startPublicScanResultFromHttp(response.status, body);
      if (!response.ok || !body.job) {
        setError(body.error ?? `The scan service returned HTTP ${response.status}.`);
        return toolResult;
      }
      setJob(body.job);
      watchJob(body.job.id);
      return toolResult;
    } catch (requestError) {
      setError(`Could not reach the scan service (${requestError instanceof Error ? requestError.message : String(requestError)}). Is it running? Start it with: pnpm --filter @okie/server dev`);
      return startPublicScanResultFromHttp(0, {});
    } finally {
      setSubmitting(false);
    }
  }
  submitRepoRef.current = submitRepo;

  async function submit(event: FormEvent) {
    event.preventDefault();
    await submitRepo(input);
  }

  const stageIndex = job ? STAGE_LABELS.findIndex(stage => stage.key === job.stage) : -1;
  const signedIn = Boolean(auth?.authenticated);
  const scanLocked = auth !== undefined && !signedIn;
  const signInHref = auth?.loginPath ?? '/api/auth/github';
  const testLoginHref = auth?.testLoginPath;
  const signOutHref = `${auth?.logoutPath ?? '/api/auth/logout'}?return=/new`;

  return (
    <main data-auth-state={auth ? (signedIn ? 'signed-in' : 'signed-out') : 'unknown'} style={page}>
      <h1 style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>Map a repository</h1>
      <p style={mutedStyle}>
        Sign in with GitHub to scan a public repository. Viewing a published atlas at{' '}
        <code>/r/owner/repo</code> stays public: there is no login wall on the map.
        AI-written descriptions layer on top of the deterministic scan.
      </p>

      {auth && (
        <p data-testid="scan-auth-status" style={{ ...mutedStyle, marginTop: '1rem' }}>
          {signedIn
            ? <>Signed in as <strong>@{auth.login}</strong>. <a href={signOutHref} style={{ color: '#79dfd4' }}>Sign out</a></>
            : <>
                <a href={signInHref} style={{ color: '#d9ff70', fontWeight: 600 }}>Sign in with GitHub</a>
                {testLoginHref
                  ? <> to scan, or <a href={testLoginHref} style={{ color: '#79dfd4' }}>use the local test sign-in</a>.</>
                  : ' to scan.'}
              </>}
        </p>
      )}

      <form onSubmit={submit} style={{ display: 'flex', gap: '0.6rem', marginTop: '1.5rem' }}>
        <input
          aria-label="GitHub repository URL"
          name="url"
          autoFocus
          disabled={scanLocked || submitting || (job !== undefined && job.stage !== 'failed')}
          onChange={event => setInput(event.target.value)}
          placeholder="https://github.com/owner/repo"
          style={{
            flex: 1,
            padding: '0.7rem 0.9rem',
            borderRadius: '8px',
            border: '1px solid #2a3a37',
            background: 'rgba(255,255,255,0.04)',
            color: '#eef4f2',
            fontSize: '0.95rem',
            fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
          }}
          value={input}
        />
        <button
          disabled={scanLocked || submitting || input.trim() === '' || (job !== undefined && job.stage !== 'failed')}
          style={{
            padding: '0.7rem 1.2rem',
            borderRadius: '8px',
            border: '1px solid #d9ff70',
            background: 'rgba(217,255,112,0.12)',
            color: '#d9ff70',
            fontWeight: 600,
            cursor: 'pointer',
          }}
          type="submit"
        >
          {submitting ? 'Submitting…' : 'Scan'}
        </button>
      </form>

      {error && <p role="alert" style={{ color: '#ff9b9b', marginTop: '1rem' }}>{error}</p>}

      {job && (
        <section aria-live="polite" style={cardStyle}>
          <h2 style={{ fontSize: '1.05rem', marginBottom: '0.75rem' }}>
            {job.owner}/{job.repo}{job.ref ? <span style={mutedStyle}> @ {job.ref}</span> : null}
          </h2>
          {job.stage === 'failed' ? (
            <p role="alert" style={{ color: '#ff9b9b' }}>{job.error ?? 'The scan failed.'}</p>
          ) : (
            <ol style={{ listStyle: 'none', display: 'grid', gap: '0.35rem' }}>
              {STAGE_LABELS.map((stage, index) => {
                const reached = stageIndex >= index || job.stage === 'complete';
                const active = stage.key === job.stage;
                const detail = stage.key === 'enriching' ? enrichmentStageDetail(job.enrichment) : undefined;
                return (
                  <li
                    data-enrichment-state={stage.key === 'enriching' ? job.enrichment.state : undefined}
                    data-enrichment-model={stage.key === 'enriching' ? job.enrichment.modelId : undefined}
                    data-enrichment-provider={stage.key === 'enriching' ? job.enrichment.provider : undefined}
                    key={stage.key}
                    style={{ color: reached ? '#eef4f2' : '#5b6a67' }}
                  >
                    {reached && !active ? '✓' : active ? '●' : '○'} {stage.label}
                    {detail ? <span style={mutedStyle}> — {detail}</span> : null}
                  </li>
                );
              })}
            </ol>
          )}
          {job.commitSha && (
            <p style={{ ...mutedStyle, marginTop: '0.75rem', fontSize: '0.85rem' }}>
              commit <code>{job.commitSha.slice(0, 12)}</code>
              {job.entityCount !== undefined ? <> · {scanEntityCountCopy(job.entityCount)}</> : null}
            </p>
          )}
          {job.atlasReady && (
            <p style={{ marginTop: '1rem' }}>
              <a
                href={job.atlasPath}
                style={{
                  color: '#0d1a17',
                  background: '#d9ff70',
                  padding: '0.55rem 1rem',
                  borderRadius: '8px',
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Open the atlas →
              </a>
              {job.stage === 'enriching' && (
                <span style={{ ...mutedStyle, marginLeft: '0.75rem', fontSize: '0.85rem' }}>
                  AI descriptions keep cooking in the background — reload later to see them.
                </span>
              )}
            </p>
          )}
        </section>
      )}

      {published.length > 0 && (
        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={{ fontSize: '1rem', color: '#b7c3c0', marginBottom: '0.5rem' }}>Already mapped</h2>
          <ul style={{ listStyle: 'none', display: 'grid', gap: '0.3rem' }}>
            {published.map(repo => {
              const href = atlasHrefForSlug(repo.slug);
              return (
                <li key={repo.slug}>
                  {href
                    ? <a href={href} style={{ color: '#79dfd4' }}>{repo.slug.replace('__', '/')}</a>
                    : <span style={mutedStyle}>{repo.slug}</span>}
                  <span style={{ ...mutedStyle, fontSize: '0.85rem' }}> · {scanEntityCountCopy(repo.entityCount)} · {repo.commitSha.slice(0, 10)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p style={{ ...mutedStyle, marginTop: '2.5rem', fontSize: '0.85rem' }}>
        Or open the public <a href="/r/THISS/okie" style={{ color: '#79dfd4' }}>THISS/okie atlas</a>
        {' '}(no login).
      </p>
    </main>
  );
}
