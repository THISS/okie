import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { getPublishedAtlasAttribution, onPublishedAtlasAttribution } from './atlasAttribution';
import { isFramedBrowsingContext } from './embedCanvas';
import {
  buildEmbedSnippet,
  DEFAULT_EMBED_PRESET,
  EMBED_OEMBED_NOTE,
  EMBED_SIZE_PRESETS,
  embedAvailabilityInput,
  embedButtonVisible,
  type EmbedSizePresetId,
} from './embedSnippet';
import { CheckIcon, CodeIcon } from './icons';
import type { PublicAtlasDisplayNames } from './oembed';

/**
 * CLA-329: the header's "Embed this atlas" button and its dialog (size presets, start-at-this-view, the iframe
 * snippet and Copy). The decisions are pure helpers below (tested in node); the component is a thin shell.
 */

export const EMBED_DIALOG_TITLE = 'Embed this atlas';
export const EMBED_COPY_FAILED_MESSAGE = 'Could not access the clipboard. Select the snippet above and copy it manually.';
export const EMBED_UNAVAILABLE_MESSAGE = "This atlas URL can't be embedded.";
const COPIED_FEEDBACK_MS = 2400;

/** Where Tab/Shift+Tab should wrap to inside the dialog, or undefined to let the browser move focus. */
export function focusTrapTarget(input: { index: number; count: number; shift: boolean }): number | undefined {
  const { index, count, shift } = input;
  if (count <= 0) return undefined;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return undefined;
}

export type EmbedClipboard = { writeText(text: string): Promise<void> } | undefined;

/** True when the snippet reached the clipboard. An empty snippet is never "copied". */
export async function copyEmbedSnippet(text: string, clipboard: EmbedClipboard): Promise<boolean> {
  if (!clipboard || !text) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab stops in order: a radio group contributes only its checked radio (as the browser does). */
function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter(element => !(element instanceof HTMLInputElement && element.type === 'radio' && !element.checked));
}

export type EmbedAvailability = { visible: boolean; displayNames?: PublicAtlasDisplayNames };

/** Whether this page offers the embed button; reacts to the publication index resolving after mount. */
export function useEmbedAtlasAvailability(portable: boolean): EmbedAvailability {
  const attribution = useSyncExternalStore(onPublishedAtlasAttribution, getPublishedAtlasAttribution, getPublishedAtlasAttribution);
  const framed = useMemo(() => isFramedBrowsingContext(), []);
  const { pathname, search } = window.location;
  return useMemo(() => {
    const visible = embedButtonVisible(embedAvailabilityInput({ pathname, search, framed, portable, attribution }));
    return attribution ? { visible, displayNames: { owner: attribution.owner, repo: attribution.repo } } : { visible };
  }, [pathname, search, framed, portable, attribution]);
}

export type EmbedDialogProps = {
  titleId: string;
  preset: EmbedSizePresetId;
  startAtView: boolean;
  snippet: string;
  copyState: 'idle' | 'copied' | 'failed';
  onPreset(preset: EmbedSizePresetId): void;
  onStartAtView(value: boolean): void;
  onCopy(): void;
};

/** The dialog's contents (no behaviour of its own). */
export function EmbedDialogBody(props: EmbedDialogProps) {
  const { titleId, preset, startAtView, snippet, copyState } = props;
  return <>
    <h2 id={titleId}>{EMBED_DIALOG_TITLE}</h2>
    <fieldset className="embed-size-presets">
      <legend>Size</legend>
      {EMBED_SIZE_PRESETS.map(candidate => (
        <label key={candidate.id}>
          <input checked={preset === candidate.id} name={`${titleId}-size`} onChange={() => props.onPreset(candidate.id)} type="radio" value={candidate.id}/>
          <span>{candidate.label}</span>
        </label>
      ))}
    </fieldset>
    <label className="embed-start-at-view">
      <input checked={startAtView} onChange={event => props.onStartAtView(event.currentTarget.checked)} type="checkbox"/>
      <span>Start at this view</span>
    </label>
    <label className="embed-snippet-field">
      <span className="sr-only">Embed code</span>
      <textarea data-testid="embed-snippet" onFocus={event => event.currentTarget.select()} readOnly rows={5} spellCheck={false} value={snippet}/>
    </label>
    {!snippet && <p className="embed-unavailable" data-testid="embed-unavailable" role="alert">{EMBED_UNAVAILABLE_MESSAGE}</p>}
    <div className="embed-copy-row">
      <button className={copyState === 'copied' ? 'copied' : undefined} data-testid="embed-copy" disabled={!snippet} onClick={props.onCopy} type="button">
        {copyState === 'copied' ? <><CheckIcon size={14}/> Copied</> : 'Copy'}
      </button>
      <span aria-live="polite" className={`embed-copy-status ${copyState}`} role="status">
        {copyState === 'failed' ? EMBED_COPY_FAILED_MESSAGE : copyState === 'copied' ? 'Embed code copied.' : ''}
      </span>
    </div>
    <p className="embed-oembed-note">{EMBED_OEMBED_NOTE}</p>
  </>;
}

export type EmbedAtlasControlProps = {
  /** Flush the live view into the URL (as Copy current view does) and return the page URL. */
  readPageHref(): string;
  displayNames?: PublicAtlasDisplayNames | undefined;
  /** Test seam; defaults to navigator.clipboard. */
  clipboard?: EmbedClipboard;
};

export function EmbedAtlasControl({ readPageHref, displayNames, clipboard }: EmbedAtlasControlProps) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<EmbedSizePresetId>(DEFAULT_EMBED_PRESET);
  const [startAtView, setStartAtView] = useState(true);
  const [pageHref, setPageHref] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const snippetFor = useCallback(
    (href: string) => (href ? buildEmbedSnippet({ pageHref: href, startAtView, preset, ...(displayNames ? { displayNames } : {}) }) ?? '' : ''),
    [startAtView, preset, displayNames],
  );
  const snippet = useMemo(() => snippetFor(pageHref), [snippetFor, pageHref]);

  const refresh = useCallback(() => {
    setPageHref(readPageHref());
    setCopyState('idle');
  }, [readPageHref]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // Focus moves into the dialog when it opens: the snippet, selected and ready to copy.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [open]);

  // A press outside the dialog (and its button) closes it; focus stays where the press put it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (dialogRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The dialog owns its keystrokes: none reach the atlas shortcuts (Escape, +/- zoom, v/c tools) on window.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const stops = tabStops(dialogRef.current);
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = focusTrapTarget({ index, count: stops.length, shift: event.shiftKey });
    if (next === undefined) return;
    event.preventDefault();
    stops[next]?.focus();
  }

  async function onCopy() {
    window.clearTimeout(copiedTimerRef.current);
    // The camera may have moved since the dialog opened: copy the live view, and show exactly what was copied.
    let text = snippet;
    if (startAtView) {
      const href = readPageHref();
      setPageHref(href);
      text = snippetFor(href);
    }
    if (!text) { setCopyState('idle'); return; } // the unavailable message already shows; nothing to copy
    const copied = await copyEmbedSnippet(text, clipboard ?? (typeof navigator === 'undefined' ? undefined : navigator.clipboard));
    setCopyState(copied ? 'copied' : 'failed');
    if (copied) copiedTimerRef.current = window.setTimeout(() => setCopyState('idle'), COPIED_FEEDBACK_MS);
    else dialogRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.select();
  }

  return (
    <div className="embed-atlas-control">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Embed this atlas"
        className={`icon-button embed-atlas-button ${open ? 'open' : ''}`}
        data-testid="embed-atlas"
        onClick={() => {
          if (open) { close(false); return; }
          refresh();
          setOpen(true);
        }}
        ref={buttonRef}
        title="Embed"
        type="button"
      >
        <CodeIcon/>
      </button>
      {open && (
        <div aria-labelledby={titleId} aria-modal="true" className="embed-popover" data-testid="embed-dialog" onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog" tabIndex={-1}>
          <EmbedDialogBody
            copyState={copyState}
            onCopy={() => { void onCopy(); }}
            onPreset={next => { setPreset(next); refresh(); }}
            onStartAtView={next => { setStartAtView(next); refresh(); }}
            preset={preset}
            snippet={snippet}
            startAtView={startAtView}
            titleId={titleId}
          />
        </div>
      )}
    </div>
  );
}
