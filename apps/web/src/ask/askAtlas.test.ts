import { describe, expect, it, vi } from 'vitest';
import { INSPECTOR_EMPTY_SUMMARY } from '../inspector/inspectorPanel';
import {
  ASK_CONNECTED_COPY,
  ASK_CONNECTED_SUBMIT_LABEL,
  ASK_DISCONNECTED_SUBMIT_LABEL,
  ASK_LOGIN_PATH,
  ASK_NOT_CONNECTED_COPY,
  ASK_NOT_CONNECTED_LIVE_MESSAGE,
  ASK_SIGNIN_COPY,
  MAX_ASK_PACKETS,
  askScopeEntityIds,
  askCitationChips,
  askRetrievalLabel,
  askSignInHref,
  appendAskAnswer,
  askPanelOverlayEdge,
  askFramedCluster,
  askShowOnMapPlan,
  keepNewerAskThread,
  buildAskContext,
  fetchAskAuth,
  resetAskAuthMemory,
  isAskUnauthorized,
  loadAskThread,
  probeAskConnection,
  resolveAskAtlasIdentity,
  accountInitials,
  atlasSourceRepositoryUrl,
  submitAskQuestion,
  type AskEntity,
  type AskThreadTurn,
} from './askAtlas';

const entities: AskEntity[] = [
  { id: 'system:okie', name: 'Okie', kind: 'system', responsibility: 'Spatial architecture atlas.' },
  { id: 'container:web-app', name: 'Web app', kind: 'container', parentId: 'system:okie', responsibility: 'React shell.', source: 'apps/web/src/App.tsx' },
  { id: 'container:scene-compiler', name: 'Scene compiler', kind: 'container', parentId: 'system:okie', responsibility: 'Compiles scenes.' },
  { id: 'component:web-shell', name: 'Application shell', kind: 'component', parentId: 'container:web-app', responsibility: 'Hosts Ask Atlas.' },
  { id: 'code:web-shell:app', name: 'App', kind: 'component', parentId: 'component:web-shell', responsibility: INSPECTOR_EMPTY_SUMMARY, source: 'apps/web/src/App.tsx' },
  { id: 'container:other', name: 'Other', kind: 'container', parentId: 'system:okie', responsibility: 'Must not leak when isolated.' },
];

const relations = [
  { id: 'relation:shell-app', from: 'component:web-shell', to: 'code:web-shell:app', label: 'renders' },
  { id: 'relation:cross', from: 'container:web-app', to: 'container:other', label: 'must not leak when isolated' },
];

describe('Ask scope is selected or isolated packets, never a silent whole-repo dump', () => {
  it('uses the isolated set when Isolate is on, excluding siblings', () => {
    const ids = askScopeEntityIds({
      entities,
      selectedId: 'system:okie',
      isolateActive: true,
      isolatedIds: ['container:web-app', 'component:web-shell'],
    });
    expect(ids).toEqual(['container:web-app', 'component:web-shell']);
    expect(ids).not.toContain('container:other');
    expect(ids).not.toContain('system:okie');
  });

  it('root selection includes the system plus direct children only', () => {
    const ids = askScopeEntityIds({
      entities,
      selectedId: 'system:okie',
      isolateActive: false,
      isolatedIds: [],
    });
    expect(ids).toEqual([
      'system:okie',
      'container:web-app',
      'container:scene-compiler',
      'container:other',
    ]);
    expect(ids).not.toContain('component:web-shell');
    expect(ids).not.toContain('code:web-shell:app');
  });

  it('container selection includes ancestors-until-root plus descendants', () => {
    const ids = askScopeEntityIds({
      entities,
      selectedId: 'container:web-app',
      isolateActive: false,
      isolatedIds: [],
    });
    expect(ids).toEqual([
      'container:web-app',
      'component:web-shell',
      'code:web-shell:app',
    ]);
    expect(ids).not.toContain('system:okie');
    expect(ids).not.toContain('container:other');
  });

  it('caps scope size so a huge isolate cannot dump the atlas', () => {
    const crowd = Array.from({ length: MAX_ASK_PACKETS + 12 }, (_, index) => ({
      id: `container:n-${index}`,
      name: `N${index}`,
      kind: 'container',
    }));
    const ids = askScopeEntityIds({
      entities: crowd,
      selectedId: crowd[0]!.id,
      isolateActive: true,
      isolatedIds: crowd.map(entity => entity.id),
    });
    expect(ids).toHaveLength(MAX_ASK_PACKETS);
  });
});

describe('Ask packets carry accepted summaries only', () => {
  it('omits placeholder copy and out-of-scope relations', () => {
    const context = buildAskContext({
      entities,
      relations,
      selectedId: 'component:web-shell',
      isolateActive: true,
      isolatedIds: ['component:web-shell', 'code:web-shell:app'],
    });
    expect(context.packets.map(packet => packet.id)).toEqual(['component:web-shell', 'code:web-shell:app']);
    expect(context.packets.find(packet => packet.id === 'component:web-shell')?.summary).toBe('Hosts Ask Atlas.');
    expect(context.packets.find(packet => packet.id === 'code:web-shell:app')?.summary).toBeUndefined();
    expect(context.relations.map(relation => relation.id)).toEqual(['relation:shell-app']);
    expect(context.relations.some(relation => relation.id === 'relation:cross')).toBe(false);
  });

  it('carries observed cyclomatic on the same packets, flagging complexity over 6', () => {
    const context = buildAskContext({
      entities: [
        { id: 'component:web-shell', name: 'Application shell', kind: 'component', parentId: 'container:web-app', responsibility: 'Hosts Ask Atlas.' },
        { id: 'code:simple', name: 'simple', kind: 'component', parentId: 'component:web-shell', cyclomaticComplexity: 1, source: 'pkg/a.ts' },
        { id: 'code:tangled', name: 'tangled', kind: 'component', parentId: 'component:web-shell', cyclomaticComplexity: 7, source: 'pkg/b.ts' },
      ],
      selectedId: 'component:web-shell',
      isolateActive: true,
      isolatedIds: ['component:web-shell', 'code:simple', 'code:tangled'],
    });
    expect(context.packets.find(packet => packet.id === 'code:simple')).toMatchObject({
      cyclomaticComplexity: 1,
      cyclomaticFlagged: false,
    });
    expect(context.packets.find(packet => packet.id === 'code:tangled')).toMatchObject({
      cyclomaticComplexity: 7,
      cyclomaticFlagged: true,
    });
    expect(context.packets.find(packet => packet.id === 'component:web-shell')?.cyclomaticComplexity).toBeUndefined();
  });

  it('carries observed clone duplicates on the same packets', () => {
    const context = buildAskContext({
      entities: [
        { id: 'component:web-shell', name: 'Application shell', kind: 'component', parentId: 'container:web-app', responsibility: 'Hosts Ask Atlas.' },
        { id: 'code:alpha', name: 'alpha', kind: 'component', parentId: 'component:web-shell', duplicates: [{ id: 'code:beta', name: 'beta' }] },
        { id: 'code:beta', name: 'beta', kind: 'component', parentId: 'component:web-shell', duplicates: [{ id: 'code:alpha', name: 'alpha' }] },
      ],
      relations: [
        { id: 'relation:dup:alpha-beta', from: 'code:alpha', to: 'code:beta', label: 'duplicates' },
        { id: 'relation:cross', from: 'code:alpha', to: 'container:other', label: 'uses' },
      ],
      selectedId: 'component:web-shell',
      isolateActive: true,
      isolatedIds: ['component:web-shell', 'code:alpha', 'code:beta'],
    });
    expect(context.packets.find(packet => packet.id === 'code:alpha')?.duplicates).toEqual([{ id: 'code:beta', name: 'beta' }]);
    expect(context.packets.find(packet => packet.id === 'code:beta')?.duplicates).toEqual([{ id: 'code:alpha', name: 'alpha' }]);
    expect(context.packets.find(packet => packet.id === 'component:web-shell')?.duplicates).toBeUndefined();
    expect(context.relations.map(relation => relation.id)).toEqual(['relation:dup:alpha-beta']);
  });

  it('carries observed lcov coverage on the same packets and omits CRAP', () => {
    const context = buildAskContext({
      entities: [
        { id: 'component:web-shell', name: 'Application shell', kind: 'component', parentId: 'container:web-app', responsibility: 'Hosts Ask Atlas.' },
        {
          id: 'code:tangled',
          name: 'tangled',
          kind: 'component',
          parentId: 'component:web-shell',
          coverageFileHitRate: 0.3,
          coverageUntestedRanges: [{ startLine: 6, endLine: 8 }],
          untestedBehaviours: [{ startLine: 6, endLine: 8, behaviour: 'Does not cover the empty token branch.' }],
          source: 'pkg/a.ts',
        },
        { id: 'code:helper', name: 'helper', kind: 'component', parentId: 'component:web-shell', source: 'pkg/b.ts' },
      ],
      selectedId: 'component:web-shell',
      isolateActive: true,
      isolatedIds: ['component:web-shell', 'code:tangled', 'code:helper'],
    });
    expect(context.packets.find(packet => packet.id === 'code:tangled')).toMatchObject({
      coverageFileHitRate: 0.3,
      coverageFileHitPercent: 30,
      coverageUntestedRanges: [{ startLine: 6, endLine: 8 }],
      untestedBehaviours: [{ startLine: 6, endLine: 8, behaviour: 'Does not cover the empty token branch.' }],
    });
    expect(context.packets.find(packet => packet.id === 'code:helper')?.coverageFileHitRate).toBeUndefined();
    expect(context.packets.find(packet => packet.id === 'component:web-shell')?.coverageFileHitRate).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('crap');
  });

  it('drops invented duplicate counterpart ids that are not in the atlas entity set', () => {
    const context = buildAskContext({
      entities: [
        { id: 'code:alpha', name: 'alpha', kind: 'component', duplicates: [{ id: 'code:invented', name: 'ghost' }, { id: 'code:beta', name: 'beta' }] },
        { id: 'code:beta', name: 'beta', kind: 'component' },
      ],
      selectedId: 'code:alpha',
      isolateActive: true,
      isolatedIds: ['code:alpha'],
    });
    expect(context.packets.find(packet => packet.id === 'code:alpha')?.duplicates).toEqual([{ id: 'code:beta', name: 'beta' }]);
  });
});

describe('Ask HTTP client', () => {
  it('treats a missing server or failed probe as disconnected without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(probeAskConnection({ fetch: fetchImpl, timeoutMs: 50 })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('probe times out as disconnected instead of hanging', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(probeAskConnection({ fetch: fetchImpl, timeoutMs: 40 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('POST with connected:false is the honest not-connected path', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ connected: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const result = await submitAskQuestion('What is Okie?', { packets: [], relations: [] }, { fetch: fetchImpl, timeoutMs: 200 });
    expect(result).toEqual({ connected: false });
  });

  it('POST returns an answer that only keeps in-scope citations from the server', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { packets: Array<{ id: string }>; atlas?: { owner: string } };
      expect(init?.credentials).toBe('include');
      expect(body.packets.map(packet => packet.id)).toEqual(['container:web-app']);
      expect(body.atlas).toEqual({ owner: 'THISS', repo: 'okie', commitSha: 'abc123' });
      return new Response(JSON.stringify({
        connected: true,
        answer: 'The web app hosts the atlas.',
        citations: ['container:web-app'],
        scopeIds: ['container:web-app'],
        thread: {
          owner: 'THISS',
          repo: 'okie',
          commitSha: 'abc123',
          turns: [{
            id: 't1',
            question: 'What does the web app do?',
            answer: 'The web app hosts the atlas.',
            citations: ['container:web-app'],
            scopeIds: ['container:web-app'],
            createdAt: 1,
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await submitAskQuestion(
      'What does the web app do?',
      { packets: [{ id: 'container:web-app', name: 'Web app', kind: 'container', summary: 'React shell.' }], relations: [] },
      { fetch: fetchImpl, timeoutMs: 200, atlas: { owner: 'THISS', repo: 'okie', commitSha: 'abc123' } },
    );
    expect(result).toEqual({
      connected: true,
      answer: 'The web app hosts the atlas.',
      citations: ['container:web-app'],
      scopeIds: ['container:web-app'],
      thread: {
        owner: 'THISS',
        repo: 'okie',
        commitSha: 'abc123',
        turns: [{
          id: 't1',
          question: 'What does the web app do?',
          answer: 'The web app hosts the atlas.',
          citations: ['container:web-app'],
          scopeIds: ['container:web-app'],
          createdAt: 1,
        }],
      },
    });
  });

  it('POST 401 is unauthorized and does not look like a connected answer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'Sign in with GitHub to ask about this atlas.',
      auth: { required: true, loginPath: '/api/auth/github' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const result = await submitAskQuestion(
      'What is Okie?',
      { packets: [{ id: 'system:okie', name: 'Okie', kind: 'system' }], relations: [] },
      { fetch: fetchImpl, timeoutMs: 200, atlas: { owner: 'THISS', repo: 'okie', commitSha: 'abc' } },
    );
    expect(isAskUnauthorized(result)).toBe(true);
    if (!isAskUnauthorized(result)) throw new Error('expected unauthorized');
    expect(result.loginPath).toBe(ASK_LOGIN_PATH);
    expect(result).not.toEqual(expect.objectContaining({ connected: true }));
  });

  it('aborts a hung POST instead of hanging the popover', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch;
    const started = Date.now();
    const result = await submitAskQuestion('What?', { packets: [], relations: [] }, { fetch: fetchImpl, timeoutMs: 40 });
    expect(result).toEqual({ connected: true, error: 'Ask timed out. Live Q&A did not complete.' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('Ask sign-in and thread identity', () => {
  it('resolves hosted /r/owner/repo plus commitSha', () => {
    expect(resolveAskAtlasIdentity({
      pathname: '/r/THISS/okie',
      commitSha: 'abc123def456',
    })).toEqual({ owner: 'THISS', repo: 'okie', commitSha: 'abc123def456', slug: 'thiss__okie' });
    expect(resolveAskAtlasIdentity({
      pathname: '/',
      search: '?fixture=scan',
      commitSha: 'deadbeef',
    })).toEqual({ owner: 'THISS', repo: 'okie', commitSha: 'deadbeef' });
    expect(resolveAskAtlasIdentity({
      pathname: '/',
      search: '?fixture=scan:colinhacks__zod',
      commitSha: 'deadbeef',
    })).toEqual({ owner: 'colinhacks', repo: 'zod', commitSha: 'deadbeef', slug: 'colinhacks__zod' });
    expect(resolveAskAtlasIdentity({
      pathname: '/',
      search: '?fixture=okie',
      commitSha: 'golden-worktree-okie-2026-07-14-v1',
    })).toEqual({ owner: 'okie', repo: 'golden', commitSha: 'golden-worktree-okie-2026-07-14-v1' });
    expect(resolveAskAtlasIdentity({ pathname: '/', search: '?fixture=stress', commitSha: 'x' })).toBeUndefined();
  });

  it('loads a thread with credentials and treats 401 as missing', async () => {
    const atlas = { owner: 'THISS', repo: 'okie', commitSha: 'abc' };
    const ok = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/ask/thread?');
      expect(init?.credentials).toBe('include');
      return new Response(JSON.stringify({
        thread: { ...atlas, turns: [{ id: 't1', question: 'Q', answer: 'A', citations: [], scopeIds: [], createdAt: 1 }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await expect(loadAskThread(atlas, { fetch: ok })).resolves.toMatchObject({
      owner: 'THISS',
      turns: [{ question: 'Q', answer: 'A' }],
    });
    const denied = vi.fn(async () => new Response(JSON.stringify({ auth: { required: true } }), { status: 401 })) as unknown as typeof fetch;
    await expect(loadAskThread(atlas, { fetch: denied })).resolves.toBeUndefined();
  });

  it('fetchAskAuth never treats a missing session as signed-in', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      authenticated: false,
      loginPath: '/api/auth/github',
      logoutPath: '/api/auth/logout',
      testLoginPath: '/api/auth/github/test-login',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(fetchAskAuth({ fetch: fetchImpl })).resolves.toEqual({
      authenticated: false,
      loginPath: '/api/auth/github',
      logoutPath: '/api/auth/logout',
      testLoginPath: '/api/auth/github/test-login',
    });
    expect(askSignInHref('/api/auth/github', '/r/THISS/okie')).toBe('/api/auth/github?return=%2Fr%2FTHISS%2Fokie');
  });

  it('fetchAskAuth flags the hosted public mode without claiming a session (CLA-266)', async () => {
    const publicMe = vi.fn(async () => new Response(JSON.stringify({ authenticated: false, mode: 'public' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const view = await fetchAskAuth({ fetch: publicMe });
    expect(view.publicMode).toBe(true);
    expect(view.authenticated).toBe(false);
    const otherMode = vi.fn(async () => new Response(JSON.stringify({ authenticated: false, mode: 'private' }), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchAskAuth({ fetch: otherMode })).publicMode).toBeUndefined();
    const failed = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect((await fetchAskAuth({ fetch: failed, retryDelayMs: 0 })).publicMode).toBeUndefined();
  });

  it('fetchAskAuth fails closed: Ask is hidden when /api/auth/me never answered with JSON (CLA-266)', async () => {
    const failures: Array<typeof fetch> = [
      vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
      vi.fn(async () => new Response('null', { status: 200 })) as unknown as typeof fetch,
      vi.fn(async () => { throw new TypeError('network down'); }) as unknown as typeof fetch,
    ];
    for (const failed of failures) {
      resetAskAuthMemory();
      const view = await fetchAskAuth({ fetch: failed, retryDelayMs: 0 });
      expect(view.askEnabled).toBe(false);
      expect(view.authenticated).toBe(false);
      expect(failed).toHaveBeenCalledTimes(2);
    }
  });

  it('fetchAskAuth retries once, and a later failure keeps the last real answer (CLA-266)', async () => {
    resetAskAuthMemory();
    const answer = { authenticated: true, login: 'octo', loginPath: '/api/auth/github', logoutPath: '/api/auth/logout' };
    const flaky = vi.fn()
      .mockRejectedValueOnce(new TypeError('blip'))
      .mockResolvedValueOnce(new Response(JSON.stringify(answer), { status: 200 })) as unknown as typeof fetch;
    const first = await fetchAskAuth({ fetch: flaky, retryDelayMs: 0 });
    expect(first).toMatchObject({ authenticated: true, login: 'octo' });
    expect(first.askEnabled).toBeUndefined();
    // Panel re-fetch during an outage: the page keeps the answer it had instead of hiding Ask.
    const down = vi.fn(async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    expect(await fetchAskAuth({ fetch: down, retryDelayMs: 0 })).toEqual(first);
    // A real answer always wins, including ask:false.
    const off = vi.fn(async () => new Response(JSON.stringify({ authenticated: false, mode: 'public', ask: false }), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchAskAuth({ fetch: off })).askEnabled).toBe(false);
    expect((await fetchAskAuth({ fetch: down, retryDelayMs: 0 })).askEnabled).toBe(false);
    // An aborted request does not wait out the retry.
    const controller = new AbortController();
    controller.abort();
    resetAskAuthMemory();
    const aborted = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    expect((await fetchAskAuth({ fetch: aborted, signal: controller.signal })).askEnabled).toBe(false);
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('fetchAskAuth maps ask:false to askEnabled:false (CLA-266 browse-only launch)', async () => {
    const me = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const off = await fetchAskAuth({ fetch: me({ authenticated: false, mode: 'public', ask: false }) });
    expect(off).toMatchObject({ publicMode: true, askEnabled: false });
    expect((await fetchAskAuth({ fetch: me({ authenticated: false, mode: 'public', ask: true }) })).askEnabled).toBeUndefined();
    // Servers that don't send the field (the local operator server) keep Ask.
    expect((await fetchAskAuth({ fetch: me({ authenticated: true, login: 'octo' }) })).askEnabled).toBeUndefined();
    expect((await fetchAskAuth({ fetch: me({ authenticated: false, mode: 'public', ask: 'no' }) })).askEnabled).toBeUndefined();
  });

  it('maps atlas identity to a real GitHub source URL (CLA-101)', () => {
    expect(atlasSourceRepositoryUrl(resolveAskAtlasIdentity({
      pathname: '/r/THISS/okie',
      commitSha: 'abc123def456',
    }))).toBe('https://github.com/THISS/okie');
    expect(atlasSourceRepositoryUrl({ owner: 'colinhacks', repo: 'zod', commitSha: 'abc' }))
      .toBe('https://github.com/colinhacks/zod');
    expect(atlasSourceRepositoryUrl({ owner: 'okie', repo: 'golden', commitSha: 'golden' }))
      .toBe('https://github.com/THISS/okie');
    expect(atlasSourceRepositoryUrl(undefined)).toBe('https://github.com/THISS/okie');
    expect(accountInitials('brenton')).toBe('BR');
    expect(accountInitials('okie-test-user')).toBe('OK');
    expect(accountInitials('x')).toBe('X');
    expect(accountInitials()).toBe('?');
  });
});

describe('honest disconnected copy', () => {
  it('does not imply a live answer or a canned explanation preview', () => {
    expect(ASK_NOT_CONNECTED_COPY).toContain('Live Q&A is not connected');
    expect(ASK_NOT_CONNECTED_COPY).toContain('Typed questions are not answered');
    expect(ASK_NOT_CONNECTED_COPY).not.toMatch(/Submitting plays/i);
    expect(ASK_NOT_CONNECTED_COPY).not.toMatch(/Preview explanation/i);
    expect(ASK_NOT_CONNECTED_LIVE_MESSAGE).toContain('Live Q&A is not connected');
    expect(ASK_NOT_CONNECTED_LIVE_MESSAGE).not.toMatch(/Playing the saved/i);
    expect(ASK_NOT_CONNECTED_LIVE_MESSAGE).toContain('overview tour was not started');
    expect(ASK_DISCONNECTED_SUBMIT_LABEL).toBe('Not connected');
    expect(ASK_CONNECTED_SUBMIT_LABEL).toBe('Ask');
    expect(ASK_CONNECTED_COPY).toContain('whole atlas');
    expect(ASK_CONNECTED_COPY).not.toContain('selected or isolated scopes');
    expect(ASK_SIGNIN_COPY).toContain('Sign in with GitHub');
    expect(ASK_SIGNIN_COPY).toContain('stays public');
  });
});

describe('CLA-265 whole-atlas answers: request slug, citation details, retrieval', () => {
  const atlas = { owner: 'THISS', repo: 'okie', commitSha: 'abc', slug: 'THISS__okie' };
  const retrieval = { mode: 'atlas', searchedWholeAtlas: true, selectedScopeIds: ['container:web-app'], retrievedScopeIds: ['container:web-app', 'component:x'], sectionCount: 7, bytes: 5120 };

  it('sends atlas.slug and parses citationDetails + retrieval defensively', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { atlas?: Record<string, string> };
      expect(body.atlas).toEqual(atlas);
      return new Response(JSON.stringify({
        connected: true,
        answer: 'Uses **App**.',
        citations: ['container:web-app', 42],
        scopeIds: ['container:web-app'],
        citationDetails: [
          { id: 'container:web-app', name: 'Web app', kind: 'container', path: 'apps/web/src/App.tsx', startLine: 3, endLine: 9 },
          { id: 'bad-no-name', kind: 'x' },
          { id: 'container:web-app', name: 'Duplicate', kind: 'container' },
          { id: 'component:x', name: 'X', kind: 'component', path: 'x.ts', startLine: -1, endLine: 'nope' },
          'junk',
        ],
        retrieval: { ...retrieval, retrievedScopeIds: ['container:web-app', 7, 'component:x'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await submitAskQuestion('Q?', { packets: [], relations: [] }, { fetch: fetchImpl, timeoutMs: 200, atlas });
    expect(result).toEqual({
      connected: true,
      answer: 'Uses **App**.',
      citations: ['container:web-app'],
      scopeIds: ['container:web-app'],
      citationDetails: [
        { id: 'container:web-app', name: 'Web app', kind: 'container', path: 'apps/web/src/App.tsx', startLine: 3, endLine: 9 },
        { id: 'component:x', name: 'X', kind: 'component', path: 'x.ts' },
      ],
      retrieval,
    });
  });

  it('ignores a malformed retrieval block and omits missing details', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      connected: true, answer: 'A', citations: [], scopeIds: [], retrieval: { mode: 'everything' }, citationDetails: 'nope',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const result = await submitAskQuestion('Q?', { packets: [], relations: [] }, { fetch: fetchImpl, timeoutMs: 200 });
    expect(result).toEqual({ connected: true, answer: 'A', citations: [], scopeIds: [] });
  });

  it('keeps old thread turns and parses new optional turn fields', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      thread: {
        owner: 'THISS', repo: 'okie', commitSha: 'abc',
        turns: [
          { id: 'old', question: 'Q1', answer: 'A1', citations: ['c'], scopeIds: [], createdAt: 1 },
          { id: 'new', question: 'Q2', answer: 'A2', citations: ['c'], scopeIds: [], createdAt: 2, citationDetails: [{ id: 'c', name: 'C', kind: 'component' }], retrieval },
          { id: 'broken', question: 'Q3' },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const thread = await loadAskThread(atlas, { fetch: fetchImpl });
    expect(thread?.turns.map(turn => turn.id)).toEqual(['old', 'new']);
    expect(thread?.turns[0]).not.toHaveProperty('citationDetails');
    expect(thread?.turns[0]).not.toHaveProperty('retrieval');
    expect(thread?.turns[1]?.citationDetails).toEqual([{ id: 'c', name: 'C', kind: 'component' }]);
    expect(thread?.turns[1]?.retrieval).toEqual(retrieval);
  });

  it('appends one local turn when the server sends no thread, else adopts the server thread', () => {
    const previous = { owner: 'THISS', repo: 'okie', commitSha: 'abc', turns: [{ id: 't0', question: 'Q0', answer: 'A0', citations: [], scopeIds: [], createdAt: 1 }] };
    const answer = { connected: true as const, answer: 'A1', citations: ['c'], scopeIds: ['s'], retrieval: retrieval as never };
    const local = appendAskAnswer(previous, { question: 'Q1', result: answer, now: 5 });
    expect(local.thread.turns.map(turn => turn.id)).toEqual(['t0', 'local-5']);
    expect(local.latestTurnId).toBe('local-5');
    expect(local.thread.turns[1]).toMatchObject({ question: 'Q1', answer: 'A1', citations: ['c'], retrieval });
    const serverTurn = { id: 's1', question: 'Q1', answer: 'A1', citations: ['c'], scopeIds: ['s'], createdAt: 9 };
    const adopted = appendAskAnswer(previous, { question: 'Q1', result: { ...answer, thread: { ...previous, turns: [...previous.turns, serverTurn] } }, now: 5 });
    expect(adopted.thread.turns.map(turn => turn.id)).toEqual(['t0', 's1']);
    expect(adopted.latestTurnId).toBe('s1');
    expect(adopted.thread.turns[1]?.retrieval).toEqual(retrieval);
  });

  it('resolves name-only chips from details, then scene, then snapshot names', () => {
    const turn: AskThreadTurn = {
      id: 't', question: 'Q', answer: 'A', scopeIds: [], createdAt: 1,
      citations: ['code:app', 'container:web-app', 'container:off-map', 'container:unknown'],
      citationDetails: [{ id: 'code:app', name: 'App', kind: 'code', path: 'apps/web/src/App.tsx', startLine: 10, endLine: 20 }],
    };
    const chips = askCitationChips(turn, {
      sceneEntity: id => id === 'container:web-app'
        ? { id, name: 'Web app', kind: 'container', detail: 'container', sourceRefs: [{ path: 'apps/web/package.json' }] }
        : id === 'code:app' ? { id, name: 'App()', kind: 'component', detail: 'code', sourceRefs: [{ path: 'apps/web/src/App.tsx', startLine: 1 }] } : undefined,
      snapshotName: id => id === 'container:off-map' ? 'Off map' : undefined,
    });
    expect(chips).toEqual([
      { focusId: 'code:app', ids: ['code:app'], mapIds: ['code:app'], label: 'App.tsx', location: 'apps/web/src/App.tsx:10–20', symbols: ['App'], onMap: true, hasSource: true },
      // Containers never become file chips, even with a manifest path.
      { focusId: 'container:web-app', ids: ['container:web-app'], mapIds: ['container:web-app'], label: 'Web app', symbols: [], onMap: true, hasSource: false },
      { focusId: 'container:off-map', ids: ['container:off-map'], mapIds: ['container:off-map'], label: 'Off map', symbols: [], onMap: true, hasSource: false },
      { focusId: 'container:unknown', ids: ['container:unknown'], mapIds: [], label: 'unknown', symbols: [], onMap: false, hasSource: false },
    ]);
  });

  it('groups a citation flood into one chip per file (basename + path:span + symbols)', () => {
    const file = 'apps/web/src/renderer/createRenderer.ts';
    const turn: AskThreadTurn = {
      id: 't', question: 'Q', answer: 'A', scopeIds: [], createdAt: 1,
      citations: ['component:create-renderer', 'code:create-renderer', 'code:recover-renderer', 'code:query', 'container:web'],
      citationDetails: [
        // The file component's name is its relative path — the chip must not repeat it next to the path.
        { id: 'component:create-renderer', name: 'src/renderer/createRenderer.ts', kind: 'component', path: file },
        { id: 'code:create-renderer', name: 'createRenderer', kind: 'code', path: file, startLine: 12, endLine: 40 },
        { id: 'code:recover-renderer', name: 'recoverRenderer', kind: 'code', path: file, startLine: 60, endLine: 88 },
        { id: 'code:query', name: 'readDemoQuery', kind: 'code', path: 'apps/web/src/renderer/query.ts', startLine: 5, endLine: 9 },
        { id: 'container:web', name: '@okie/web', kind: 'container' },
      ],
    };
    const inScene = new Set(turn.citations);
    const chips = askCitationChips(turn, { sceneEntity: id => inScene.has(id) ? { id, name: id, kind: 'component' } : undefined });
    expect(chips.map(chip => [chip.label, chip.location, chip.symbols, chip.focusId])).toEqual([
      ['createRenderer.ts', `${file}:12–88`, ['createRenderer', 'recoverRenderer'], 'component:create-renderer'],
      ['query.ts', 'apps/web/src/renderer/query.ts:5–9', ['readDemoQuery'], 'code:query'],
      ['@okie/web', undefined, [], 'container:web'],
    ]);
    expect(chips[0]!.ids).toEqual(['component:create-renderer', 'code:create-renderer', 'code:recover-renderer']);
    // Whole-file citation alone → no line span; several symbols without the file → focus their file component.
    const wholeFile = askCitationChips({ citations: ['component:create-renderer'], citationDetails: turn.citationDetails!.slice(0, 1) }, { sceneEntity: () => undefined });
    expect(wholeFile[0]).toMatchObject({ label: 'createRenderer.ts', location: file, symbols: [] });
    const symbolsOnly = askCitationChips(
      { citations: ['code:create-renderer', 'code:recover-renderer'], citationDetails: turn.citationDetails!.slice(1, 3) },
      { sceneEntity: id => ({ id, name: id, kind: 'code', parentId: 'component:create-renderer' }) },
    );
    expect(symbolsOnly).toHaveLength(1);
    expect(symbolsOnly[0]!.focusId).toBe('component:create-renderer');
  });

  it('labels which scopes were searched', () => {
    expect(askRetrievalLabel(undefined)).toBeUndefined();
    expect(askRetrievalLabel(retrieval as never)).toBe('Searched: whole atlas · 7 sections');
    expect(askRetrievalLabel({ ...retrieval, mode: 'scope-only', searchedWholeAtlas: false, sectionCount: 1 } as never))
      .toBe('Searched: selected scope only (1 part) · 1 section');
  });

  it('overlays the response retrieval when the persisted turn lacks selectedScopeIds', () => {
    const previous = { owner: 'THISS', repo: 'okie', commitSha: 'abc', turns: [] };
    const persisted = { id: 's1', question: 'Q', answer: 'A', citations: [], scopeIds: [], createdAt: 1, retrieval: { ...retrieval, selectedScopeIds: [], sectionCount: 3 } as never };
    const answer = { connected: true as const, answer: 'A', citations: [], scopeIds: [], retrieval: retrieval as never, thread: { ...previous, turns: [persisted] } };
    expect(appendAskAnswer(previous, { question: 'Q', result: answer, now: 1 }).thread.turns[0]?.retrieval).toEqual(retrieval);
    const complete = { ...persisted, retrieval: { ...retrieval, sectionCount: 3 } as never };
    expect(appendAskAnswer(previous, { question: 'Q', result: { ...answer, thread: { ...previous, turns: [complete] } }, now: 1 }).thread.turns[0]?.retrieval)
      .toEqual({ ...retrieval, sectionCount: 3 });
  });

  it('never duplicates a turn and a late thread load does not roll back an answer', () => {
    const answer = { connected: true as const, answer: 'A', citations: [], scopeIds: [] };
    const once = appendAskAnswer(undefined, { question: 'Q', result: answer, now: 7 });
    const twice = appendAskAnswer(once.thread, { question: 'Q', result: answer, now: 7 });
    expect(twice.thread.turns.map(turn => turn.id)).toEqual(['local-7']);
    expect(appendAskAnswer(undefined, { question: 'Q', result: answer, now: 7 }).latestTurnId).toBe(once.latestTurnId);
    const stale = { ...once.thread, turns: [] };
    expect(keepNewerAskThread(once.thread, stale)).toBe(once.thread);
    const fresh = { ...once.thread, turns: [...once.thread.turns, { ...once.thread.turns[0]!, id: 'x' }] };
    expect(keepNewerAskThread(once.thread, fresh)).toBe(fresh);
    expect(keepNewerAskThread(undefined, stale)).toBe(stale);
  });

  it('frames around the panel: left dock beside the map, bottom sheet on a narrow stage', () => {
    expect(askPanelOverlayEdge({ width: 372 }, { width: 1064 })).toBe('left');
    expect(askPanelOverlayEdge({ width: 366 }, { width: 390 })).toBe('bottom');
    expect(askPanelOverlayEdge({ width: 624 }, { width: 648 })).toBe('bottom');
    expect(askPanelOverlayEdge(undefined, { width: 390 })).toBe('left');
  });

  it('Show on map frames the largest on-screen cluster from the first citation at a fixed band', () => {
    const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {
      a: { x: 0, y: 0, width: 80, height: 40 },
      near: { x: 100, y: 0, width: 80, height: 40 },
      far: { x: 2000, y: 0, width: 80, height: 40 },
    };
    const viewport = { width: 1000, height: 800 };
    const safe = { top: 100, right: 50, bottom: 100, left: 450 };
    // A band-locked framer: fixed zoom 2, centred on the union inside the safe area.
    const frame = (ids: readonly string[]) => {
      const list = ids.map(id => boxes[id]!);
      const left = Math.min(...list.map(b => b.x));
      const right = Math.max(...list.map(b => b.x + b.width));
      const top = Math.min(...list.map(b => b.y));
      const bottom = Math.max(...list.map(b => b.y + b.height));
      const zoom = 2;
      const safeCx = safe.left + (viewport.width - safe.left - safe.right) / 2;
      const safeCy = safe.top + (viewport.height - safe.top - safe.bottom) / 2;
      return { x: (left + right) / 2 - (safeCx - viewport.width / 2) / zoom, y: (top + bottom) / 2 - (safeCy - viewport.height / 2) / zoom, zoom };
    };
    const cluster = askFramedCluster(['a', 'far', 'near', 'undrawn'], id => boxes[id], frame, viewport, safe);
    expect(cluster.ids).toEqual(['a', 'near']);
    expect(cluster.smallestPx).toBe(80);
    expect(askFramedCluster(['undrawn'], id => boxes[id], frame, viewport, safe)).toEqual({ ids: [], camera: undefined, smallestPx: 0 });
  });

  it('Show on map picks L3 inside one container, else L2 across containers', () => {
    const rows: Record<string, { kind: string; parentId?: string }> = {
      'system:okie': { kind: 'softwareSystem' },
      'container:web': { kind: 'container', parentId: 'system:okie' },
      'container:server': { kind: 'container', parentId: 'system:okie' },
      'component:adapter': { kind: 'component', parentId: 'container:web' },
      'code:adapter:class': { kind: 'code', parentId: 'component:adapter' },
      'component:create': { kind: 'component', parentId: 'container:web' },
      'component:ask': { kind: 'component', parentId: 'container:server' },
      // Golden-style nested component (code-detail component under a file component).
      'component:shell': { kind: 'component', parentId: 'container:web' },
      'component:shell:app': { kind: 'component', parentId: 'component:shell' },
    };
    const lookup = (id: string) => rows[id];
    // Declarations and files in one container → L3 inside it, cited files (declarations lift to their file).
    expect(askShowOnMapPlan(['code:adapter:class', 'component:adapter', 'component:create', 'container:web'], lookup))
      .toEqual({ level: 'component', containerId: 'container:web', focusIds: ['component:adapter', 'component:create'] });
    expect(askShowOnMapPlan(['component:shell:app'], lookup))
      .toEqual({ level: 'component', containerId: 'container:web', focusIds: ['component:shell'] });
    // Spanning containers → L2 with the containers that hold cited parts.
    expect(askShowOnMapPlan(['code:adapter:class', 'component:ask', 'system:okie'], lookup))
      .toEqual({ level: 'container', focusIds: ['container:web', 'container:server'] });
    // Only a container cited → L2 with that container.
    expect(askShowOnMapPlan(['container:server', 'system:okie'], lookup)).toEqual({ level: 'container', focusIds: ['container:server'] });
    // Nothing placeable → no plan.
    expect(askShowOnMapPlan(['system:okie', 'code:unknown'], lookup)).toBeUndefined();
  });
});
