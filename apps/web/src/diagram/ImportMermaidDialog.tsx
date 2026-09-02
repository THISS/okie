import { useEffect, useId, useRef, type ChangeEvent, type FormEvent } from 'react';
import { CloseIcon, FileIcon } from '../icons';

type ImportMermaidDialogProps = {
  error?: string;
  open: boolean;
  source: string;
  onClose: () => void;
  onImport: (source: string) => void;
  onSourceChange: (source: string) => void;
};

export function ImportMermaidDialog({
  error,
  open,
  source,
  onClose,
  onImport,
  onSourceChange,
}: ImportMermaidDialogProps) {
  const headingId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    onImport(source);
  }

  function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text().then(text => {
      onSourceChange(text);
      onImport(text);
    });
  }

  return (
    <div className="import-mermaid-backdrop">
      <form
        aria-labelledby={headingId}
        aria-modal="true"
        className="import-mermaid-dialog"
        data-testid="import-mermaid-dialog"
        onSubmit={submit}
        role="dialog"
      >
        <header>
          <h2 id={headingId}>Import Mermaid</h2>
          <button aria-label="Close import Mermaid" onClick={onClose} type="button">
            <CloseIcon size={14}/>
          </button>
        </header>
        <p>Paste a flowchart, sequence, or C4 diagram — or open a <code>.mmd</code> / Markdown file. It is laid out on the atlas as Okie nodes and edges, not as a Mermaid SVG.</p>
        <label className="import-mermaid-field">
          <span className="sr-only">Mermaid source</span>
          <textarea
            aria-invalid={error ? true : undefined}
            aria-label="Mermaid source"
            onChange={event => onSourceChange(event.target.value)}
            placeholder={'flowchart TD\n  A[Start] --> B[Finish]'}
            ref={textareaRef}
            spellCheck={false}
            value={source}
          />
        </label>
        {error && <p className="import-mermaid-error" role="alert">{error}</p>}
        <footer>
          <input
            accept=".md,.mmd,.mermaid,.txt,text/markdown,text/plain"
            hidden
            onChange={openFile}
            ref={fileRef}
            type="file"
          />
          <button onClick={() => fileRef.current?.click()} type="button">
            <FileIcon size={14}/>
            Open file
          </button>
          <span className="import-mermaid-spacer"/>
          <button onClick={onClose} type="button">Cancel</button>
          <button className="import-mermaid-submit" type="submit">Import onto atlas</button>
        </footer>
      </form>
    </div>
  );
}
