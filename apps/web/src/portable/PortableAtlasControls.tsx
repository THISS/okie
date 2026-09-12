import { useRef, useState } from 'react';
import type { PortableAtlas } from '@okie/architecture';

export type PortableActionResult = { ok: true } | { ok: false; message: string };

export function PortableAtlasControls({
  bundle,
  onReplace,
  onForget,
  notice,
}: {
  bundle: PortableAtlas;
  onReplace(file: File): Promise<PortableActionResult>;
  onForget(): Promise<PortableActionResult>;
  notice?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const choose = () => input.current?.click();
  const replace = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const result = await onReplace(file);
    if (!result.ok) setMessage(result.message);
    setBusy(false);
  };
  const forget = async () => {
    setBusy(true);
    const result = await onForget();
    if (!result.ok) setMessage(result.message);
    setBusy(false);
  };
  return <aside aria-label="Portable atlas controls" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem 1rem', background: '#10201d', borderTop: '1px solid #49615a', color: '#eef4f2', padding: '0.5rem 0.75rem', font: '12px IBM Plex Sans, sans-serif' }}>
    <strong>Local atlas</strong>
    <span>{bundle.repository.commitSha.slice(0, 12)}</span>
    <details style={{ maxWidth: 520 }}>
      <summary>Analysis coverage{bundle.analysis.mode === 'quick' || bundle.analysis.adapters.some(adapter => adapter.coverage !== 'semantic' || adapter.limitations.length > 0) ? ' · limited' : ''}</summary>
      <div style={{ maxHeight: '35vh', overflow: 'auto' }}>
        <p>{bundle.analysis.mode === 'quick' ? 'Quick scan: relationships may be missing.' : 'Full analysis was requested. Available results depend on each language tool and repository dependencies.'}</p>
        {bundle.analysis.adapters.length === 0 && <p>No language analyzer reported coverage.</p>}
        {bundle.analysis.adapters.map((adapter, index) => <section key={`${adapter.language}-${index}`}>
          <strong>{adapter.language}: {adapter.coverage === 'semantic' ? 'resolved symbols' : adapter.coverage === 'syntax' ? 'syntax only' : 'analyzer unavailable'}</strong>
          {adapter.limitations.length > 0 && <ul>{adapter.limitations.slice(0, 5).map((limitation, item) => <li key={item}>{limitation}</li>)}</ul>}
          {adapter.limitations.length > 5 && <details><summary>Show {adapter.limitations.length - 5} more limitations</summary><ul>{adapter.limitations.slice(5).map((limitation, item) => <li key={item}>{limitation}</li>)}</ul></details>}
        </section>)}
      </div>
    </details>
    <input accept="application/json,.json" aria-label="Replace local atlas" hidden onChange={event => void replace(event.currentTarget.files?.[0])} ref={input} type="file" />
    <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
      <button disabled={busy} onClick={choose} type="button">Replace…</button>
      <button disabled={busy} onClick={() => void forget()} type="button">Forget</button>
    </div>
    {message ?? notice ? <p role="alert" style={{ color: '#ffb4a9', maxWidth: 260, margin: '0.5rem 0 0' }}>{message ?? notice}</p> : null}
  </aside>;
}
