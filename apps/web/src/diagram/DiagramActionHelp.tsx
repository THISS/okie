import { useId, useState, type ReactNode } from 'react';
import { InfoIcon } from '../icons';

export function DiagramActionHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  return <span className="diagram-action-help" data-dismissed={dismissed ? 'true' : 'false'} onMouseEnter={() => setDismissed(false)} onFocus={() => setDismissed(false)} data-open={open ? 'true' : 'false'} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); setDismissed(true); } }}>
    <button aria-label={label} aria-expanded={open} aria-controls={id} aria-describedby={id} onClick={() => { setDismissed(false); setOpen(value => !value); }} type="button"><InfoIcon size={14}/></button>
    <span className="diagram-help-content" id={id} role="tooltip">{children}</span>
  </span>;
}
