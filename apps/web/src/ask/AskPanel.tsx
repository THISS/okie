import { useEffect, useRef, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import { BlockMarkdown } from '../explanation/markdownLite';
import { ArrowIcon, CloseIcon, CodeIcon, FitIcon } from '../icons';
import {
  ASK_CONNECTED_COPY,
  ASK_CONNECTED_SUBMIT_LABEL,
  ASK_DISCONNECTED_SUBMIT_LABEL,
  ASK_NOT_CONNECTED_COPY,
  ASK_SIGNIN_COPY,
  askRetrievalLabel,
  askSignInHref,
  type AskAuthView,
  type AskCitationChip,
  type AskThreadTurn,
} from './askAtlas';
import './ask.css';

/**
 * CLA-265 Ask Atlas panel body. One thread (persisted turns + the in-flight
 * question) is the only scroll container; the composer stays pinned below it.
 * Each answer renders once, as markdown-lite, with citation chips that select
 * and frame the cited part on the map and a per-answer "Show on map" that
 * isolates the cited set. App owns state and map actions; this is the view.
 */
export type AskTurnActions = {
  /** Resolved chips for a turn (server details, else scene names/paths). */
  citationsFor: (turn: AskThreadTurn) => AskCitationChip[];
  onFocusCitation: (id: string) => void;
  onOpenCitationSource: (id: string) => void;
  /** Isolate + frame the turn's cited parts that are in this atlas. */
  onShowOnMap: (citedIds: string[], turn: AskThreadTurn) => void;
  onRestoreMap: () => void;
};

export type AskPanelProps = AskTurnActions & {
  placement?: 'floating' | 'docked';
  onTogglePlacement?: () => void;
  signedIn: boolean;
  auth?: AskAuthView;
  returnPath: string;
  connected: boolean;
  state: string;
  question: string;
  /** The question being answered right now, shown once as the thread's last turn. */
  pendingQuestion?: string;
  warmingUp?: boolean;
  error?: string;
  turns: readonly AskThreadTurn[];
  /** Turn answered in this session; marks `data-ask-answer` and is announced. */
  latestTurnId?: string;
  /** Turn whose cited set is isolated on the map right now. */
  mapTurnId?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  onQuestionChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
};

export function AskPanel(props: AskPanelProps) {
  if (!props.signedIn) {
    const loginPath = props.auth?.loginPath ?? '/api/auth/github';
    return (
      <div className={`ask-popover ${props.placement === 'docked' ? 'ask-docked' : ''}`} data-ask-placement={props.placement ?? 'floating'} data-ask-auth="signed-out" data-ask-connected="false" data-ask-state="signin">
        <p>{ASK_SIGNIN_COPY}</p>
        <a className="ask-signin" data-testid="ask-signin" href={askSignInHref(loginPath, props.returnPath)}>Sign in with GitHub</a>
        {props.auth?.testLoginPath ? <a className="ask-test-login" data-testid="ask-test-login" href={askSignInHref(props.auth.testLoginPath, props.returnPath)}>Use the local test sign-in</a> : null}
      </div>
    );
  }
  return <AskThreadForm {...props}/>;
}

function AskThreadForm(props: AskPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasThread = props.turns.length > 0 || Boolean(props.pendingQuestion) || Boolean(props.error);
  const lastTurnId = props.turns.at(-1)?.id;
  // Keep the newest question in view: its top when an answer lands (answers are
  // read from the start), the bottom while a question is in flight.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (props.pendingQuestion || props.error) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    const turns = scroller.querySelectorAll<HTMLElement>('[data-ask-thread-turn]');
    const last = turns[turns.length - 1];
    scroller.scrollTop = last ? Math.max(0, last.offsetTop - 4) : scroller.scrollHeight;
  }, [lastTurnId, props.pendingQuestion, props.error]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
      return;
    }
    // Cmd/Ctrl+Enter submits; plain Enter stays a newline.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <form
      aria-label="Ask Atlas"
      className={`ask-popover ${props.placement === 'docked' ? 'ask-docked' : ''}`} data-ask-placement={props.placement ?? 'floating'}
      data-ask-auth={props.signedIn ? 'signed-in' : 'unknown'}
      data-ask-connected={props.connected ? 'true' : 'false'}
      data-ask-has-thread={hasThread ? 'true' : 'false'}
      data-ask-state={props.state}
      onSubmit={props.onSubmit}
    >
      <header className="ask-header">
        <label htmlFor="atlas-question">Ask about this codebase</label>
        {props.onTogglePlacement ? <button aria-label={props.placement === 'docked' ? 'Float Ask Atlas' : 'Expand Ask into side panel'} className="ask-placement" onClick={props.onTogglePlacement} type="button">{props.placement === 'docked' ? 'Float' : 'Expand'}</button> : null}
        <button aria-label="Close Ask Atlas" className="ask-close" onClick={props.onClose} type="button"><CloseIcon size={14}/></button>
      </header>
      {hasThread ? (
        <div className="ask-scroll" data-ask-scroll="" ref={scrollRef}>
          <AskThreadList {...props}/>
          {props.error ? <p className="ask-error" role="alert">{props.error}</p> : null}
        </div>
      ) : null}
      <div className="ask-composer">
        <textarea
          autoFocus
          id="atlas-question"
          onChange={event => props.onQuestionChange(event.target.value)}
          onKeyDown={onKeyDown}
          onKeyPress={event => event.stopPropagation()}
          placeholder="How does this system work, end to end?"
          ref={props.inputRef}
          rows={2}
          value={props.question}
        />
        {!props.connected
          ? <p className="ask-note">{ASK_NOT_CONNECTED_COPY}</p>
          : props.turns.length === 0 && !props.pendingQuestion ? <p className="ask-note">{ASK_CONNECTED_COPY}</p> : null}
        <p className="ask-note">5 Asks per signed-in user each day (resets at midnight UTC). Conversations stay in this browser and are not synced to your account.</p>
        <button className="ask-submit" disabled={!props.connected || !props.question.trim() || Boolean(props.pendingQuestion)} type="submit">
          {props.pendingQuestion ? 'Asking…' : props.connected ? ASK_CONNECTED_SUBMIT_LABEL : ASK_DISCONNECTED_SUBMIT_LABEL}
          {props.pendingQuestion || !props.connected ? null : <ArrowIcon size={15}/>}
        </button>
      </div>
    </form>
  );
}

/** The one thread. Hook-free so tests can walk its element tree. */
export function AskThreadList(props: Pick<AskPanelProps, 'turns' | 'pendingQuestion' | 'warmingUp' | 'latestTurnId' | 'mapTurnId'> & AskTurnActions) {
  if (props.turns.length === 0 && !props.pendingQuestion) return null;
  return (
    <ol className="ask-thread" data-ask-thread="" data-ask-thread-count={props.turns.length}>
      {props.turns.map(turn => <AskTurn actions={props} key={turn.id} latest={turn.id === props.latestTurnId} onMap={turn.id === props.mapTurnId} turn={turn}/>)}
      {props.pendingQuestion ? (
        <li aria-busy="true" className="ask-turn" data-ask-thread-turn="pending">
          <p className="ask-thread-question">{props.pendingQuestion}</p>
          <p className="ask-pending" role="status">{props.warmingUp ? 'Warming up Ask… The service sleeps when idle. Your question will run when it is ready.' : 'Searching the atlas and source…'}</p>
        </li>
      ) : null}
    </ol>
  );
}

/** Chips shown before the "+N more" disclosure. */
export const ASK_CITATION_CHIP_LIMIT = 6;

function AskCitationChipItem({ chip, actions }: { chip: AskCitationChip; actions: AskTurnActions }) {
  const symbols = chip.symbols.join(', ');
  const title = chip.onMap
    ? [`Select ${chip.label} on the map`, chip.location, symbols ? `Cites: ${symbols}` : ''].filter(Boolean).join('\n')
    : `${chip.label} is not in this atlas`;
  return (
    <li data-ask-citation={chip.focusId}>
      <button className="ask-citation-chip" disabled={!chip.onMap} onClick={() => actions.onFocusCitation(chip.focusId)} title={title} type="button">
        <strong>{chip.label}</strong>
        {chip.location ? <small>{chip.location}</small> : null}
        {symbols ? <small className="ask-citation-symbols">{symbols}</small> : null}
      </button>
      {chip.hasSource ? (
        <button aria-label={`Open source for ${chip.label}`} className="ask-citation-source" onClick={() => actions.onOpenCitationSource(chip.focusId)} title="Open source" type="button"><CodeIcon size={13}/></button>
      ) : null}
    </li>
  );
}

export function AskTurn({ turn, latest, onMap, actions }: { turn: AskThreadTurn; latest: boolean; onMap: boolean; actions: AskTurnActions }) {
  const chips = actions.citationsFor(turn);
  const retrieval = askRetrievalLabel(turn.retrieval);
  const mapIds = [...new Set(chips.flatMap(chip => chip.mapIds))];
  const shown = chips.slice(0, ASK_CITATION_CHIP_LIMIT);
  const more = chips.slice(ASK_CITATION_CHIP_LIMIT);
  return (
    <li className="ask-turn" data-ask-thread-turn={turn.id}>
      <p className="ask-thread-question">{turn.question}</p>
      <div className="ask-answer" {...(latest ? { 'data-ask-answer': '', role: 'status' } : {})}>
        <BlockMarkdown className="ask-answer-body" text={turn.answer}/>
      </div>
      {retrieval ? <p className="ask-retrieval" data-ask-retrieval={turn.retrieval?.mode}>{retrieval}</p> : null}
      {chips.length > 0 ? (
        <ul aria-label="Cited parts" className="ask-citations">
          {shown.map(chip => <AskCitationChipItem actions={actions} chip={chip} key={chip.focusId}/>)}
        </ul>
      ) : null}
      {more.length > 0 ? (
        <details className="ask-citations-more" data-ask-citations-more={more.length}>
          <summary>+{more.length} more</summary>
          <ul aria-label="More cited parts" className="ask-citations">
            {more.map(chip => <AskCitationChipItem actions={actions} chip={chip} key={chip.focusId}/>)}
          </ul>
        </details>
      ) : null}
      {mapIds.length > 0 ? (
        <div className="ask-turn-actions">
          {onMap
            ? <button aria-pressed="true" className="ask-show-on-map" data-ask-show-on-map="" onClick={actions.onRestoreMap} type="button"><FitIcon size={13}/> Restore full view</button>
            : <button aria-pressed="false" className="ask-show-on-map" data-ask-show-on-map="" onClick={() => actions.onShowOnMap(mapIds, turn)} type="button"><FitIcon size={13}/> Show {mapIds.length === 1 ? 'it' : `all ${mapIds.length}`} on map</button>}
        </div>
      ) : null}
    </li>
  );
}
