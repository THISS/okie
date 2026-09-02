import { describe, expect, it, vi } from 'vitest';
import { INSPECTOR_EMPTY_SUMMARY } from '../inspector/inspectorPanel';
import {
  ASK_CONNECTED_COPY,
  ASK_NOT_CONNECTED_COPY,
  ASK_NOT_CONNECTED_LIVE_MESSAGE,
  MAX_ASK_PACKETS,
  askScopeEntityIds,
  askScopeKey,
  buildAskContext,
  probeAskConnection,
  shouldCommitAskAnswer,
  submitAskQuestion,
  type AskEntity,
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

  it('does not commit an in-flight or leftover answer after the scope changes', () => {
    const selected = askScopeKey({ selectedId: 'container:web-app', isolateActive: false, isolatedIds: [] });
    const other = askScopeKey({ selectedId: 'container:other', isolateActive: false, isolatedIds: [] });
    const isolated = askScopeKey({
      selectedId: 'system:okie',
      isolateActive: true,
      isolatedIds: ['container:web-app', 'component:web-shell'],
    });
    expect(selected).toBe('select:container:web-app');
    expect(other).not.toBe(selected);
    expect(isolated).toBe('isolate:component:web-shell,container:web-app');
    expect(isolated).not.toBe(askScopeKey({ selectedId: 'system:okie', isolateActive: false, isolatedIds: [] }));
    expect(shouldCommitAskAnswer(selected, selected)).toBe(true);
    expect(shouldCommitAskAnswer(selected, other)).toBe(false);
    expect(shouldCommitAskAnswer(selected, isolated)).toBe(false);
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
      const body = JSON.parse(String(init?.body)) as { packets: Array<{ id: string }> };
      expect(body.packets.map(packet => packet.id)).toEqual(['container:web-app']);
      return new Response(JSON.stringify({
        connected: true,
        answer: 'The web app hosts the atlas.',
        citations: ['container:web-app'],
        scopeIds: ['container:web-app'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await submitAskQuestion(
      'What does the web app do?',
      { packets: [{ id: 'container:web-app', name: 'Web app', kind: 'container', summary: 'React shell.' }], relations: [] },
      { fetch: fetchImpl, timeoutMs: 200 },
    );
    expect(result).toEqual({
      connected: true,
      answer: 'The web app hosts the atlas.',
      citations: ['container:web-app'],
      scopeIds: ['container:web-app'],
    });
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

describe('honest disconnected copy', () => {
  it('keeps the not-connected explanation path copy', () => {
    expect(ASK_NOT_CONNECTED_COPY).toContain('Live Q&A is not connected');
    expect(ASK_NOT_CONNECTED_LIVE_MESSAGE).toContain('Live repository Q&A is not connected yet');
    expect(ASK_CONNECTED_COPY).toContain('packets and accepted summaries');
    expect(ASK_CONNECTED_COPY).toContain('selected or isolated');
  });
});
