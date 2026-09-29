import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AskPanel, AskThreadList, type AskPanelProps, type AskTurnActions } from './AskPanel';
import { askCitationChips, type AskThreadTurn } from './askAtlas';

const oldTurn: AskThreadTurn = {
  id: 'old',
  question: 'What is the web app?',
  answer: 'The web app hosts the atlas.',
  citations: ['container:web-app'],
  scopeIds: ['container:web-app'],
  createdAt: 1,
};

const newTurn: AskThreadTurn = {
  id: 'new',
  question: 'How does rendering work?',
  answer: 'The **renderer** draws via `compile-scene.ts`.\n\n- first\n- second',
  citations: ['container:web-app', 'code:app'],
  scopeIds: [],
  createdAt: 2,
  citationDetails: [{ id: 'code:app', name: 'App', kind: 'code', path: 'apps/web/src/App.tsx', startLine: 10, endLine: 20 }],
  retrieval: { mode: 'atlas', searchedWholeAtlas: true, selectedScopeIds: [], retrievedScopeIds: ['container:web-app'], sectionCount: 12, bytes: 900 },
};

const sceneEntities = new Map([
  ['container:web-app', { id: 'container:web-app', name: 'Web app', kind: 'container', detail: 'container' }],
  ['code:app', { id: 'code:app', name: 'App()', kind: 'component', detail: 'code', sourceRefs: [{ path: 'apps/web/src/App.tsx', startLine: 1 }] }],
]);

function actions(): AskTurnActions & { [K in 'onFocusCitation' | 'onOpenCitationSource' | 'onShowOnMap' | 'onRestoreMap']: ReturnType<typeof vi.fn> } {
  return {
    citationsFor: turn => askCitationChips(turn, { sceneEntity: id => sceneEntities.get(id) }),
    onFocusCitation: vi.fn(),
    onOpenCitationSource: vi.fn(),
    onShowOnMap: vi.fn(),
    onRestoreMap: vi.fn(),
  };
}

function props(overrides: Partial<AskPanelProps> = {}): AskPanelProps {
  return {
    ...actions(),
    signedIn: true,
    returnPath: '/r/THISS/okie',
    connected: true,
    state: 'answered',
    question: '',
    turns: [oldTurn, newTurn],
    latestTurnId: 'new',
    onQuestionChange: () => undefined,
    onSubmit: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

/** Expand hook-free function components and collect every host element. */
function hostElements(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const child of node) hostElements(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function') {
    return hostElements((element.type as (props: unknown) => ReactNode)(element.props), out);
  }
  out.push(element);
  hostElements(element.props.children as ReactNode, out);
  return out;
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('AskPanel (CLA-265)', () => {
  it('renders each answer once inside the one thread, with no copy below the input', () => {
    const html = renderToStaticMarkup(<AskPanel {...props()}/>);
    expect(count(html, 'data-ask-thread-turn=')).toBe(2);
    expect(count(html, 'data-ask-answer=""')).toBe(1);
    expect(count(html, 'class="ask-answer"')).toBe(2);
    expect(count(html, 'The web app hosts the atlas.')).toBe(1);
    expect(count(html, 'draws via')).toBe(1);
    // The latest answer sits in the thread, before the composer.
    expect(html.indexOf('data-ask-answer=""')).toBeGreaterThan(html.indexOf('data-ask-thread=""'));
    expect(html.indexOf('data-ask-answer=""')).toBeLessThan(html.indexOf('id="atlas-question"'));
    expect(html.slice(html.indexOf('class="ask-composer"'))).not.toContain('ask-answer');
  });

  it('has exactly one scroll container wrapping the thread', () => {
    const html = renderToStaticMarkup(<AskPanel {...props()}/>);
    expect(count(html, 'data-ask-scroll=""')).toBe(1);
    expect(html.indexOf('data-ask-scroll=""')).toBeLessThan(html.indexOf('data-ask-thread=""'));
    expect(html).not.toContain('style="overflow');
  });

  it('renders answer markdown through markdown-lite (no raw markers, no HTML injection)', () => {
    const html = renderToStaticMarkup(<AskPanel {...props({ turns: [{ ...newTurn, answer: 'Uses **App** and `x.ts`. <img src=x onerror=alert(1)>' }] })}/>);
    expect(html).toContain('<strong>App</strong>');
    expect(html).toContain('<code>x.ts</code>');
    expect(html).not.toContain('<img');
    const list = renderToStaticMarkup(<AskPanel {...props()}/>);
    expect(list).toContain('<li>first</li>');
  });

  it('shows named citation chips with path:start–end and the retrieval line', () => {
    const html = renderToStaticMarkup(<AskPanel {...props()}/>);
    expect(html).toContain('data-ask-citation="code:app"');
    expect(html).toContain('<strong>App.tsx</strong><small>apps/web/src/App.tsx:10–20</small><small class="ask-citation-symbols">App</small>');
    expect(html).toContain('<strong>Web app</strong>');
    expect(html).not.toMatch(/>container:web-app</);
    expect(html).toContain('Searched: whole atlas · 12 sections');
    expect(html).toContain('aria-label="Open source for App.tsx"');
  });

  it('citation chip click focuses the entity; the source affordance opens source', () => {
    const turnActions = actions();
    const elements = hostElements(<AskThreadList {...turnActions} latestTurnId="new" turns={[newTurn]}/>);
    const chip = elements.find(element => element.props.className === 'ask-citation-chip' && String(element.props.title).startsWith('Select App.tsx on the map'));
    (chip?.props.onClick as () => void)();
    expect(turnActions.onFocusCitation).toHaveBeenCalledWith('code:app');
    const source = elements.find(element => element.props['aria-label'] === 'Open source for App.tsx');
    (source?.props.onClick as () => void)();
    expect(turnActions.onOpenCitationSource).toHaveBeenCalledWith('code:app');
  });

  it('caps visible chips and folds the rest behind "+N more", one chip per file', () => {
    const many: AskThreadTurn = {
      ...newTurn,
      citations: Array.from({ length: 22 }, (_, index) => `code:f${index % 9}:s${index}`),
      citationDetails: Array.from({ length: 22 }, (_, index) => ({ id: `code:f${index % 9}:s${index}`, name: `sym${index}`, kind: 'code', path: `src/f${index % 9}.ts`, startLine: index + 1, endLine: index + 2 })),
    };
    const html = renderToStaticMarkup(<AskPanel {...props({ turns: [many] })}/>);
    expect(count(html, 'data-ask-citation=')).toBe(9);
    expect(count(html, 'data-ask-citations-more="3"')).toBe(1);
    expect(html).toContain('<summary>+3 more</summary>');
    expect(html.indexOf('<summary>+3 more</summary>')).toBeGreaterThan(html.lastIndexOf('f5.ts</strong>'));
  });

  it('Cmd/Ctrl+Enter submits the form; plain Enter does not', () => {
    const src = readFileSync(new URL('./AskPanel.tsx', import.meta.url), 'utf8');
    expect(src).toContain("event.key === 'Enter' && (event.metaKey || event.ctrlKey)");
    expect(src).toContain('event.currentTarget.form?.requestSubmit()');
  });

  it('Show on map isolates the cited ids; the active turn offers Restore', () => {
    const turnActions = actions();
    const elements = hostElements(<AskThreadList {...turnActions} turns={[newTurn]}/>);
    const show = elements.find(element => element.props.className === 'ask-show-on-map');
    (show?.props.onClick as () => void)();
    expect(turnActions.onShowOnMap).toHaveBeenCalledWith(['container:web-app', 'code:app'], newTurn);
    const active = hostElements(<AskThreadList {...turnActions} mapTurnId="new" turns={[newTurn]}/>)
      .find(element => element.props.className === 'ask-show-on-map');
    expect(active?.props['aria-pressed']).toBe('true');
    (active?.props.onClick as () => void)();
    expect(turnActions.onRestoreMap).toHaveBeenCalled();
  });

  it('renders old-format turns (no details, no retrieval) with scene names', () => {
    const html = renderToStaticMarkup(<AskPanel {...props({ turns: [oldTurn], latestTurnId: undefined, state: 'ready' })}/>);
    expect(html).toContain('What is the web app?');
    expect(html).toContain('<strong>Web app</strong>');
    expect(html).not.toContain('Searched:');
    expect(html).not.toContain('data-ask-answer');
  });

  it('shows the in-flight question once as a pending turn', () => {
    const html = renderToStaticMarkup(<AskPanel {...props({ turns: [oldTurn], latestTurnId: undefined, pendingQuestion: 'Where is routing?', question: 'Where is routing?', state: 'asking' })}/>);
    expect(html).toContain('data-ask-thread-turn="pending"');
    expect(count(html, '<p class="ask-thread-question">Where is routing?</p>')).toBe(1);
    expect(html).toContain('Asking…');
  });

  it('keeps sign-in, disconnected and empty states and their data attributes', () => {
    const signedOut = renderToStaticMarkup(<AskPanel {...props({ signedIn: false, auth: { authenticated: false, loginPath: '/api/auth/github', logoutPath: '/api/auth/logout', testLoginPath: '/api/auth/test' } })}/>);
    expect(signedOut).toContain('data-ask-auth="signed-out"');
    expect(signedOut).toContain('data-ask-state="signin"');
    expect(signedOut).toContain('data-testid="ask-signin"');
    expect(signedOut).toContain('data-testid="ask-test-login"');
    const disconnected = renderToStaticMarkup(<AskPanel {...props({ connected: false, turns: [], latestTurnId: undefined, state: 'disconnected' })}/>);
    expect(disconnected).toContain('data-ask-connected="false"');
    expect(disconnected).toContain('Live Q&amp;A is not connected');
    expect(disconnected).toContain('Not connected');
    expect(disconnected).not.toContain('data-ask-scroll');
    const empty = renderToStaticMarkup(<AskPanel {...props({ turns: [], latestTurnId: undefined, state: 'ready' })}/>);
    expect(empty).toContain('whole atlas');
    expect(empty).toContain('data-ask-auth="signed-in"');
  });

  it('shows an error inside the thread area', () => {
    const html = renderToStaticMarkup(<AskPanel {...props({ turns: [], latestTurnId: undefined, error: 'Ask failed (500).', state: 'error' })}/>);
    expect(html).toContain('role="alert"');
    expect(html.indexOf('Ask failed (500).')).toBeGreaterThan(html.indexOf('data-ask-scroll=""'));
  });
});
