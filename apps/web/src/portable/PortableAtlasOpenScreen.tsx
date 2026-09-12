import { useState, type DragEvent } from 'react';
import type { PortableActionResult } from './PortableAtlasControls';

export function PortableAtlasOpenScreen({ error, onOpen }: { error?: string; onOpen(file: File): Promise<PortableActionResult> }) {
  const [message, setMessage] = useState(error);
  const [busy, setBusy] = useState(false);
  const open = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const result = await onOpen(file);
    setBusy(false);
    if (!result.ok) setMessage(result.message);
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void open(event.dataTransfer.files[0]);
  };
  return <main onDragOver={event => event.preventDefault()} onDrop={drop} style={{ maxWidth: 640, margin: '10vh auto', padding: '2rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif' }}>
    <h1>Open a local atlas</h1>
    <p>Drop an <code>.okie.json</code> scan bundle here or choose a file. It stays on this device; no repository is uploaded.</p>
    <label style={{ display: 'inline-block', border: '1px dashed #79dfd4', borderRadius: 8, padding: '1rem', cursor: busy ? 'wait' : 'pointer' }}>
      <input accept="application/json,.json" disabled={busy} onChange={event => void open(event.currentTarget.files?.[0])} style={{ display: 'none' }} type="file" />
      {busy ? 'Checking atlas…' : 'Choose local atlas…'}
    </label>
    {message ? <p role="alert" style={{ color: '#ffb4a9', whiteSpace: 'pre-wrap' }}>{message}</p> : null}
  </main>;
}
