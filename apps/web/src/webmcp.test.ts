import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_ATLAS_INPUT_SCHEMA,
  ASK_ATLAS_TOOL,
  ASK_ATLAS_TOOL_NAME,
  ATLAS_WEBMCP_TOOLS,
  GET_ATLAS_CONTEXT_INPUT_SCHEMA,
  GET_ATLAS_CONTEXT_TOOL,
  GET_ATLAS_CONTEXT_TOOL_NAME,
  ISOLATE_INPUT_SCHEMA,
  ISOLATE_TOOL,
  ISOLATE_TOOL_NAME,
  LANDING_REPO_INPUT_SCHEMA,
  LANDING_WEBMCP_TOOLS,
  OKIE_PROBE_INPUT_SCHEMA,
  OKIE_PROBE_TOOL,
  OKIE_PROBE_TOOL_DESCRIPTION,
  OKIE_PROBE_TOOL_NAME,
  OPEN_SHARE_ATLAS_TOOL,
  OPEN_SHARE_ATLAS_TOOL_NAME,
  SELECT_ENTITY_INPUT_SCHEMA,
  SELECT_ENTITY_TOOL,
  SELECT_ENTITY_TOOL_NAME,
  SET_C4_LEVEL_INPUT_SCHEMA,
  SET_C4_LEVEL_TOOL,
  SET_C4_LEVEL_TOOL_NAME,
  START_OVERVIEW_TOUR_INPUT_SCHEMA,
  START_OVERVIEW_TOUR_TOOL,
  START_OVERVIEW_TOUR_TOOL_NAME,
  START_PUBLIC_SCAN_TOOL,
  START_PUBLIC_SCAN_TOOL_NAME,
  WEBMCP_HOST_HEADERS,
  atlasEnrichmentStatus,
  atlasIdentityFromLocation,
  atlasPageContext,
  atlasTourPlaying,
  bindAtlasChromeActions,
  bindScanLandingActions,
  detectModelContext,
  okieProbeResult,
  parseC4LevelInput,
  parseEntityIdInput,
  parsePublicRepoInput,
  publicAtlasPath,
  publicGithubRepoUrl,
  publicScanFetchInit,
  registerWebMcpAtlasTools,
  registerWebMcpFoundation,
  registerWebMcpLandingTools,
  startPublicScanResultFromHttp,
  type AtlasChromeActions,
  type AtlasPageContextInput,
  type WebMcpTool,
  type WebMcpHost,
} from './webmcp';

const PLANTED_SECRETS = [
  'okie-test-llm-key-cla40-fake',
  'gho_okieTestPlantedSecretCla40xxxx',
  'sk-okie-test-operator-token',
  'OPENROUTER_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'scanRoot',
  '127.0.0.1:4180',
];

const SECRET_LEAK = /apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|gho_|ghp_|sk-|Bearer |scanRoot|4180/i;

function publicSurface(...values: unknown[]): string {
  return JSON.stringify(values);
}

describe('WebMCP foundation (CLA-40)', () => {
  it('no-ops when the API is absent', async () => {
    const registerTool = vi.fn();
    await expect(registerWebMcpFoundation({})).resolves.toBe('absent');
    await expect(registerWebMcpFoundation({ document: {}, navigator: {} })).resolves.toBe('absent');
    await expect(registerWebMcpFoundation({
      document: { modelContext: {} },
      navigator: { modelContext: { registerTool: 'nope' } },
    })).resolves.toBe('absent');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('does not throw when detect walks a throwing host', async () => {
    const host: WebMcpHost = {
      get document(): never {
        throw new Error('okie-test-llm-key-cla40-fake');
      },
    };
    await expect(registerWebMcpFoundation(host)).resolves.toBe('absent');
  });

  it('registers the documented probe tool with a JSON schema when a test double is present', async () => {
    const registerTool = vi.fn(async (tool: WebMcpTool) => tool);
    const status = await registerWebMcpFoundation({ document: { modelContext: { registerTool } } });
    expect(status).toBe('registered');
    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0]![0];
    expect(tool.name).toBe(OKIE_PROBE_TOOL_NAME);
    expect(tool.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(tool.description).toBe(OKIE_PROBE_TOOL_DESCRIPTION);
    expect(tool.inputSchema).toEqual(OKIE_PROBE_INPUT_SCHEMA);
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.annotations.readOnlyHint).toBe(true);
    const result = tool.execute({ planted: 'gho_okieTestPlantedSecretCla40xxxx' });
    expect(result).toEqual(okieProbeResult());
    const published = publicSurface(tool.name, tool.title, tool.description, tool.inputSchema, result);
    expect(SECRET_LEAK.test(published)).toBe(false);
    for (const secret of PLANTED_SECRETS) {
      expect(published).not.toContain(secret);
    }
  });

  it('prefers document.modelContext over navigator.modelContext', async () => {
    const documentRegister = vi.fn(async () => undefined);
    const navigatorRegister = vi.fn(async () => undefined);
    const host = {
      document: { modelContext: { registerTool: documentRegister } },
      navigator: { modelContext: { registerTool: navigatorRegister } },
    };
    expect(detectModelContext(host)).toBe(host.document.modelContext);
    await expect(registerWebMcpFoundation(host)).resolves.toBe('registered');
    expect(documentRegister).toHaveBeenCalledOnce();
    expect(navigatorRegister).not.toHaveBeenCalled();
  });

  it('falls back to navigator.modelContext when document has no API', async () => {
    const registerTool = vi.fn(async () => undefined);
    await expect(registerWebMcpFoundation({
      document: {},
      navigator: { modelContext: { registerTool } },
    })).resolves.toBe('registered');
    expect(registerTool).toHaveBeenCalledWith(OKIE_PROBE_TOOL);
  });

  it('does not fail boot when registerTool rejects', async () => {
    const registerTool = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(registerWebMcpFoundation({
      document: { modelContext: { registerTool } },
    })).resolves.toBe('skipped');
  });

  it('keeps origin isolation: tools=(self), origin-keyed cluster, no document.domain', () => {
    expect(WEBMCP_HOST_HEADERS['Permissions-Policy']).toBe('tools=(self)');
    expect(WEBMCP_HOST_HEADERS['Permissions-Policy']).not.toMatch(/\*|all/);
    expect(WEBMCP_HOST_HEADERS['Origin-Agent-Cluster']).toBe('?1');
    expect(WEBMCP_HOST_HEADERS['Origin-Agent-Cluster']).not.toBe('?0');

    const webSrc = [
      readFileSync(new URL('./webmcp.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./main.tsx', import.meta.url), 'utf8'),
      readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'),
      readFileSync(new URL('./oembed.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8'),
      readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(webSrc).not.toMatch(/document\.domain\s*=/);
    expect(webSrc).not.toMatch(/Origin-Agent-Cluster['":\s]+\?0/);
    expect(webSrc).not.toMatch(/tools=\(\*\)|tools=\*|allow=["'][^"']*tools/);
  });

  it('wires detection into hosted chrome boot and host headers', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('registerWebMcpFoundation');
    expect(main).not.toMatch(/registerWebMcpLandingTools|registerWebMcpAtlasTools|start_public_scan|open_share_atlas|set_c4_level|select_entity|get_atlas_context/);

    const landing = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(landing).toContain('registerWebMcpLandingTools');
    expect(landing).toContain('bindScanLandingActions');
    expect(landing).toContain('publicScanFetchInit');
    expect(landing).not.toMatch(/okie_select|okie_isolate|okie_level|okie_tour|okie_ask|set_c4_level|select_entity|start_overview_tour|ask_atlas|get_atlas_context|registerWebMcpAtlasTools/);
    expect(landing).not.toMatch(/document\.domain\s*=/);

    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('registerWebMcpAtlasTools');
    expect(app).toContain('bindAtlasChromeActions');
    expect(app).toContain('readContext');
    expect(app).toContain('atlasIdentityFromLocation');
    expect(app).toContain('atlasTourPlaying');
    expect(app).toContain('atlasTourPlaying({ storyStep, storyPlaying, storyPhase })');
    expect(app).not.toMatch(/document\.domain\s*=/);
    expect(app).not.toContain('registerWebMcpLandingTools');

    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain('WEBMCP_HOST_HEADERS');
    expect(viteConfig).toContain('okieWebMcpHeadersPlugin');

    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const applied = vercel.headers?.flatMap(entry => entry.headers) ?? [];
    expect(applied).toEqual(expect.arrayContaining([
      { key: 'Permissions-Policy', value: 'tools=(self)' },
      { key: 'Origin-Agent-Cluster', value: '?1' },
    ]));
    expect(applied.some(header => header.key === 'Permissions-Policy' && header.value !== 'tools=(self)')).toBe(false);
  });
});

describe('WebMCP landing tools (CLA-41)', () => {
  afterEach(() => {
    bindScanLandingActions({
      fillRepoInput: () => {},
      submitScan: async () => startPublicScanResultFromHttp(0, {}),
      openAtlas: () => {},
    })();
    vi.unstubAllGlobals();
  });

  it('no-ops when the API is absent', async () => {
    const registerTool = vi.fn();
    await expect(registerWebMcpLandingTools({})).resolves.toBe('absent');
    await expect(registerWebMcpLandingTools({ document: {}, navigator: {} })).resolves.toBe('absent');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('registers start_public_scan and open_share_atlas with JSON schemas when a test double is present', async () => {
    const registerTool = vi.fn(async (tool: WebMcpTool) => tool);
    const status = await registerWebMcpLandingTools({ document: { modelContext: { registerTool } } });
    expect(status).toBe('registered');
    expect(registerTool).toHaveBeenCalledTimes(2);
    const names = registerTool.mock.calls.map(call => call[0].name);
    expect(names).toEqual([START_PUBLIC_SCAN_TOOL_NAME, OPEN_SHARE_ATLAS_TOOL_NAME]);
    expect(LANDING_WEBMCP_TOOLS.map(tool => tool.name)).toEqual(names);

    for (const [tool] of registerTool.mock.calls) {
      expect(tool.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
      expect(tool.inputSchema).toEqual(LANDING_REPO_INPUT_SCHEMA);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['owner', 'repo']);
      expect(tool.annotations.readOnlyHint).toBe(false);
    }
  });

  it('returns a structured tool error for invalid owner/repo without throwing', async () => {
    const fillRepoInput = vi.fn();
    const submitScan = vi.fn(async () => startPublicScanResultFromHttp(202, {
      job: { owner: 'acme', repo: 'widgets', atlasPath: '/r/acme/widgets' },
    }));
    const openAtlas = vi.fn();
    bindScanLandingActions({ fillRepoInput, submitScan, openAtlas });

    const invalid = [
      undefined,
      {},
      { owner: '', repo: 'widgets' },
      { owner: 'acme', repo: '' },
      { owner: 'acme/evil', repo: 'widgets' },
      { owner: 'not a repo', repo: 'x' },
      { owner: '..', repo: 'widgets' },
      { owner: 'acme', repo: 're po' },
      { owner: 'https://github.com/acme', repo: 'widgets' },
    ];
    for (const input of invalid) {
      await expect(Promise.resolve(START_PUBLIC_SCAN_TOOL.execute(input))).resolves.toMatchObject({
        ok: false,
        isError: true,
        error: { code: 'invalid_repo' },
      });
      await expect(Promise.resolve(OPEN_SHARE_ATLAS_TOOL.execute(input))).resolves.toMatchObject({
        ok: false,
        isError: true,
        error: { code: 'invalid_repo' },
      });
    }
    expect(fillRepoInput).not.toHaveBeenCalled();
    expect(submitScan).not.toHaveBeenCalled();
    expect(openAtlas).not.toHaveBeenCalled();
    expect(() => parsePublicRepoInput({ owner: 'nope', repo: 'also nope' })).not.toThrow();
  });

  it('fills the paste box and kicks the same public scan POST; anonymous 401 is a structured error', async () => {
    const fillRepoInput = vi.fn();
    const openAtlas = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('include');
      const headers = init?.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.stringify(init)).not.toMatch(/Authorization|Bearer |gho_|GITHUB_TOKEN|GH_TOKEN/i);
      return new Response(JSON.stringify({
        error: 'Sign in with GitHub to scan a repository. Viewing a published atlas at /r/owner/repo stays public — there is no login wall on the map.',
        auth: { required: true, loginPath: '/api/auth/github' },
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    bindScanLandingActions({
      fillRepoInput,
      submitScan: async url => {
        const response = await fetch('/api/scans', publicScanFetchInit(url));
        return startPublicScanResultFromHttp(response.status, await response.json());
      },
      openAtlas,
    });

    const result = await START_PUBLIC_SCAN_TOOL.execute({
      owner: 'acme',
      repo: 'widgets',
      apiKey: 'okie-test-llm-key-cla40-fake',
      token: 'gho_okieTestPlantedSecretCla40xxxx',
    });
    expect(fillRepoInput).toHaveBeenCalledWith(publicGithubRepoUrl('acme', 'widgets'));
    expect(fetchMock).toHaveBeenCalledWith('/api/scans', publicScanFetchInit(publicGithubRepoUrl('acme', 'widgets')));
    expect(result).toEqual(startPublicScanResultFromHttp(401, {}));
    expect(result).toMatchObject({ ok: false, isError: true, error: { code: 'unauthorized' } });
    expect(openAtlas).not.toHaveBeenCalled();
  });

  it('returns only public scan facts when POST accepts the same form request', async () => {
    const fillRepoInput = vi.fn();
    bindScanLandingActions({
      fillRepoInput,
      submitScan: async () => startPublicScanResultFromHttp(202, {
        job: {
          id: 'job_public_fixture',
          owner: 'acme',
          repo: 'widgets',
          atlasPath: '/r/acme/widgets',
          enrichment: { note: 'okie-test-llm-key-cla40-fake' },
        },
        error: 'OPENROUTER_API_KEY',
      }),
      openAtlas: () => {},
    });
    const result = await START_PUBLIC_SCAN_TOOL.execute({ owner: 'acme', repo: 'widgets' });
    expect(fillRepoInput).toHaveBeenCalledWith('https://github.com/acme/widgets');
    expect(result).toEqual({
      ok: true,
      tool: START_PUBLIC_SCAN_TOOL_NAME,
      owner: 'acme',
      repo: 'widgets',
      atlasPath: '/r/acme/widgets',
    });
    expect(SECRET_LEAK.test(JSON.stringify(result))).toBe(false);
    const init = publicScanFetchInit('https://github.com/acme/widgets');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(JSON.stringify(init)).not.toMatch(/Authorization|Bearer |GITHUB_TOKEN|GH_TOKEN|gho_/i);
  });

  it('opens a public atlas path through the page navigation action', async () => {
    const fillRepoInput = vi.fn();
    const submitScan = vi.fn();
    const openAtlas = vi.fn();
    bindScanLandingActions({ fillRepoInput, submitScan, openAtlas });

    const result = await OPEN_SHARE_ATLAS_TOOL.execute({ owner: 'THISS', repo: 'okie' });
    expect(openAtlas).toHaveBeenCalledWith(publicAtlasPath('THISS', 'okie'));
    expect(submitScan).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      tool: OPEN_SHARE_ATLAS_TOOL_NAME,
      owner: 'THISS',
      repo: 'okie',
      atlasPath: '/r/THISS/okie',
    });
  });

  it('does not put secrets in landing tool names, descriptions, inputs, or results', async () => {
    const fillRepoInput = vi.fn();
    bindScanLandingActions({
      fillRepoInput,
      submitScan: async () => startPublicScanResultFromHttp(202, {
        job: { owner: 'acme', repo: 'widgets', atlasPath: '/r/acme/widgets' },
      }),
      openAtlas: () => {},
    });

    const scan = await START_PUBLIC_SCAN_TOOL.execute({
      owner: 'acme',
      repo: 'widgets',
      OPENROUTER_API_KEY: PLANTED_SECRETS[0],
      GITHUB_TOKEN: PLANTED_SECRETS[1],
    });
    const atlas = await OPEN_SHARE_ATLAS_TOOL.execute({ owner: 'acme', repo: 'widgets' });
    const invalid = await START_PUBLIC_SCAN_TOOL.execute({
      owner: 'not a repo',
      repo: 'sk-okie-test-operator-token',
      token: 'gho_okieTestPlantedSecretCla40xxxx',
    });

    const published = publicSurface(
      START_PUBLIC_SCAN_TOOL.name,
      START_PUBLIC_SCAN_TOOL.title,
      START_PUBLIC_SCAN_TOOL.description,
      START_PUBLIC_SCAN_TOOL.inputSchema,
      OPEN_SHARE_ATLAS_TOOL.name,
      OPEN_SHARE_ATLAS_TOOL.title,
      OPEN_SHARE_ATLAS_TOOL.description,
      OPEN_SHARE_ATLAS_TOOL.inputSchema,
      scan,
      atlas,
      invalid,
    );
    expect(SECRET_LEAK.test(published)).toBe(false);
    for (const secret of PLANTED_SECRETS) {
      expect(published).not.toContain(secret);
    }
    expect(published).not.toContain('127.0.0.1:4180');
    expect(published).not.toContain('scanRoot');
  });

  it('does not fail boot when landing registerTool rejects', async () => {
    const registerTool = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(registerWebMcpLandingTools({
      document: { modelContext: { registerTool } },
    })).resolves.toBe('skipped');
  });
});

function defaultContext(overrides: Partial<AtlasPageContextInput> = {}): AtlasPageContextInput {
  return {
    atlas: { fixtureId: 'okie' },
    c4Level: 'context',
    selectedEntityId: 'system:okie',
    tourPlaying: false,
    enrichmentStatus: 'none',
    scanAvailable: false,
    askAvailable: true,
    ...overrides,
  };
}

function bindFakeAtlas(overrides: Partial<AtlasChromeActions> = {}) {
  const live = defaultContext();
  const actions: AtlasChromeActions = {
    hasEntity: entityId => entityId === 'system:okie' || entityId === 'container:web-app',
    selectEntity: entityId => {
      live.selectedEntityId = entityId;
    },
    setC4Level: level => {
      live.c4Level = level;
    },
    isolate: () => {},
    startOverviewTour: () => {
      live.tourPlaying = true;
      live.askAvailable = false;
    },
    openAsk: () => {},
    readContext: () => ({ ...live }),
    ...overrides,
  };
  return { actions, live, unbind: bindAtlasChromeActions(actions) };
}

describe('WebMCP atlas tools (CLA-42)', () => {
  afterEach(() => {
    bindFakeAtlas().unbind();
  });

  it('no-ops when the API is absent', async () => {
    const registerTool = vi.fn();
    await expect(registerWebMcpAtlasTools({})).resolves.toBe('absent');
    await expect(registerWebMcpAtlasTools({ document: {}, navigator: {} })).resolves.toBe('absent');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('registers the atlas tools with JSON schemas when a test double is present', async () => {
    const registerTool = vi.fn(async (tool: WebMcpTool) => tool);
    const status = await registerWebMcpAtlasTools({ document: { modelContext: { registerTool } } });
    expect(status).toBe('registered');
    expect(registerTool).toHaveBeenCalledTimes(6);
    const names = registerTool.mock.calls.map(call => call[0].name);
    expect(names).toEqual([
      SET_C4_LEVEL_TOOL_NAME,
      SELECT_ENTITY_TOOL_NAME,
      ISOLATE_TOOL_NAME,
      START_OVERVIEW_TOUR_TOOL_NAME,
      ASK_ATLAS_TOOL_NAME,
      GET_ATLAS_CONTEXT_TOOL_NAME,
    ]);
    expect(ATLAS_WEBMCP_TOOLS.map(tool => tool.name)).toEqual(names);

    const tools = registerTool.mock.calls.map(call => call[0]);
    expect(tools[0]!.inputSchema).toEqual(SET_C4_LEVEL_INPUT_SCHEMA);
    expect(tools[1]!.inputSchema).toEqual(SELECT_ENTITY_INPUT_SCHEMA);
    expect(tools[2]!.inputSchema).toEqual(ISOLATE_INPUT_SCHEMA);
    expect(tools[3]!.inputSchema).toEqual(START_OVERVIEW_TOUR_INPUT_SCHEMA);
    expect(tools[4]!.inputSchema).toEqual(ASK_ATLAS_INPUT_SCHEMA);
    expect(tools[5]!.inputSchema).toEqual(GET_ATLAS_CONTEXT_INPUT_SCHEMA);
    expect(tools[5]!.annotations.readOnlyHint).toBe(true);
    for (const tool of tools.slice(0, 5)) {
      expect(tool.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations.readOnlyHint).toBe(false);
    }
  });

  it('returns a structured tool error for unknown entity or level without throwing', async () => {
    const selectEntity = vi.fn();
    const setC4Level = vi.fn();
    const isolate = vi.fn();
    bindFakeAtlas({ selectEntity, setC4Level, isolate });

    const unknownLevels = [undefined, {}, { level: '' }, { level: 'layer-9' }, { level: 'not-a-band' }];
    for (const input of unknownLevels) {
      await expect(Promise.resolve(SET_C4_LEVEL_TOOL.execute(input))).resolves.toMatchObject({
        ok: false,
        isError: true,
        error: { code: 'unknown_level' },
      });
    }

    const unknownEntities = [undefined, {}, { entityId: '' }, { entityId: 'missing:nope' }, { entityId: 'not a node' }];
    for (const input of unknownEntities) {
      await expect(Promise.resolve(SELECT_ENTITY_TOOL.execute(input))).resolves.toMatchObject({
        ok: false,
        isError: true,
        error: { code: 'unknown_entity' },
      });
    }
    for (const input of [{ entityId: '' }, { entityId: 'missing:nope' }, { entityId: 'not a node' }]) {
      await expect(Promise.resolve(ISOLATE_TOOL.execute(input))).resolves.toMatchObject({
        ok: false,
        isError: true,
        error: { code: 'unknown_entity' },
      });
    }

    expect(selectEntity).not.toHaveBeenCalled();
    expect(setC4Level).not.toHaveBeenCalled();
    expect(isolate).not.toHaveBeenCalled();
    expect(() => parseC4LevelInput({ level: 'nope' })).not.toThrow();
    expect(() => parseEntityIdInput({ entityId: 'missing:nope' })).not.toThrow();
  });

  it('calls existing chrome actions for level, select, isolate, tour, and Ask', async () => {
    const selectEntity = vi.fn();
    const setC4Level = vi.fn();
    const isolate = vi.fn();
    const startOverviewTour = vi.fn();
    const openAsk = vi.fn();
    bindFakeAtlas({ selectEntity, setC4Level, isolate, startOverviewTour, openAsk });

    await expect(Promise.resolve(SET_C4_LEVEL_TOOL.execute({ level: 'L2' }))).resolves.toEqual({
      ok: true,
      tool: SET_C4_LEVEL_TOOL_NAME,
      level: 'container',
    });
    expect(setC4Level).toHaveBeenCalledWith('container');

    await expect(Promise.resolve(SELECT_ENTITY_TOOL.execute({ entityId: 'system:okie' }))).resolves.toEqual({
      ok: true,
      tool: SELECT_ENTITY_TOOL_NAME,
      entityId: 'system:okie',
    });
    expect(selectEntity).toHaveBeenCalledWith('system:okie');

    await expect(Promise.resolve(ISOLATE_TOOL.execute({ entityId: 'container:web-app' }))).resolves.toEqual({
      ok: true,
      tool: ISOLATE_TOOL_NAME,
      visibilityMode: 'isolate',
    });
    expect(selectEntity).toHaveBeenCalledWith('container:web-app');
    expect(isolate).toHaveBeenCalledWith(true);

    await expect(Promise.resolve(ISOLATE_TOOL.execute({ active: false }))).resolves.toEqual({
      ok: true,
      tool: ISOLATE_TOOL_NAME,
      visibilityMode: 'all',
    });
    expect(isolate).toHaveBeenCalledWith(false);

    await expect(Promise.resolve(START_OVERVIEW_TOUR_TOOL.execute({}))).resolves.toEqual({
      ok: true,
      tool: START_OVERVIEW_TOUR_TOOL_NAME,
      step: 0,
    });
    expect(startOverviewTour).toHaveBeenCalledOnce();

    await expect(Promise.resolve(ASK_ATLAS_TOOL.execute({ question: 'How does the golden fixture compile?' }))).resolves.toEqual({
      ok: true,
      tool: ASK_ATLAS_TOOL_NAME,
      open: true,
    });
    expect(openAsk).toHaveBeenCalledWith('How does the golden fixture compile?');
  });

  it('does not put secrets in atlas tool names, descriptions, inputs, or results', async () => {
    bindFakeAtlas();

    const level = await SET_C4_LEVEL_TOOL.execute({
      level: 'code',
      OPENROUTER_API_KEY: PLANTED_SECRETS[0],
      GITHUB_TOKEN: PLANTED_SECRETS[1],
    });
    const selected = await SELECT_ENTITY_TOOL.execute({
      entityId: 'system:okie',
      token: PLANTED_SECRETS[0],
    });
    const isolated = await ISOLATE_TOOL.execute({ active: true, apiKey: PLANTED_SECRETS[2] });
    const tour = await START_OVERVIEW_TOUR_TOOL.execute({
      OPENROUTER_API_KEY: PLANTED_SECRETS[0],
    });
    const ask = await ASK_ATLAS_TOOL.execute({
      question: PLANTED_SECRETS[0],
      GITHUB_TOKEN: PLANTED_SECRETS[1],
    });
    const unknownLevel = await SET_C4_LEVEL_TOOL.execute({
      level: PLANTED_SECRETS[2],
      token: 'gho_okieTestPlantedSecretCla40xxxx',
    });
    const unknownEntity = await SELECT_ENTITY_TOOL.execute({
      entityId: PLANTED_SECRETS[0],
    });

    const published = publicSurface(
      SET_C4_LEVEL_TOOL.name,
      SET_C4_LEVEL_TOOL.title,
      SET_C4_LEVEL_TOOL.description,
      SET_C4_LEVEL_TOOL.inputSchema,
      SELECT_ENTITY_TOOL.name,
      SELECT_ENTITY_TOOL.title,
      SELECT_ENTITY_TOOL.description,
      SELECT_ENTITY_TOOL.inputSchema,
      ISOLATE_TOOL.name,
      ISOLATE_TOOL.title,
      ISOLATE_TOOL.description,
      ISOLATE_TOOL.inputSchema,
      START_OVERVIEW_TOUR_TOOL.name,
      START_OVERVIEW_TOUR_TOOL.title,
      START_OVERVIEW_TOUR_TOOL.description,
      START_OVERVIEW_TOUR_TOOL.inputSchema,
      ASK_ATLAS_TOOL.name,
      ASK_ATLAS_TOOL.title,
      ASK_ATLAS_TOOL.description,
      ASK_ATLAS_TOOL.inputSchema,
      level,
      selected,
      isolated,
      tour,
      ask,
      unknownLevel,
      unknownEntity,
    );
    expect(SECRET_LEAK.test(published)).toBe(false);
    for (const secret of PLANTED_SECRETS) {
      expect(published).not.toContain(secret);
    }
    expect(published).not.toContain('127.0.0.1:4180');
    expect(published).not.toContain('scanRoot');
  });

  it('does not fail boot when atlas registerTool rejects', async () => {
    const registerTool = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(registerWebMcpAtlasTools({
      document: { modelContext: { registerTool } },
    })).resolves.toBe('skipped');
  });

  it('returns unavailable without throwing when atlas chrome is not bound', async () => {
    bindFakeAtlas().unbind();
    await expect(Promise.resolve(SET_C4_LEVEL_TOOL.execute({ level: 'context' }))).resolves.toMatchObject({
      ok: false,
      isError: true,
      error: { code: 'unavailable' },
    });
    await expect(Promise.resolve(SELECT_ENTITY_TOOL.execute({ entityId: 'system:okie' }))).resolves.toMatchObject({
      ok: false,
      isError: true,
      error: { code: 'unavailable' },
    });
  });
});

describe('WebMCP page context (CLA-43)', () => {
  afterEach(() => {
    bindFakeAtlas().unbind();
  });

  it('no-ops when the API is absent', async () => {
    const registerTool = vi.fn();
    await expect(registerWebMcpAtlasTools({})).resolves.toBe('absent');
    await expect(registerWebMcpAtlasTools({ document: {}, navigator: {} })).resolves.toBe('absent');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('registers get_atlas_context and returns the listed public fields', async () => {
    bindFakeAtlas();
    const registerTool = vi.fn(async (tool: WebMcpTool) => tool);
    const status = await registerWebMcpAtlasTools({ document: { modelContext: { registerTool } } });
    expect(status).toBe('registered');
    const tool = registerTool.mock.calls.map(call => call[0]).find(candidate => candidate.name === GET_ATLAS_CONTEXT_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(tool!.inputSchema).toEqual(GET_ATLAS_CONTEXT_INPUT_SCHEMA);
    expect(tool!.annotations.readOnlyHint).toBe(true);

    const result = await tool!.execute({
      OPENROUTER_API_KEY: PLANTED_SECRETS[0],
      GITHUB_TOKEN: PLANTED_SECRETS[1],
    });
    expect(result).toEqual({
      ok: true,
      tool: GET_ATLAS_CONTEXT_TOOL_NAME,
      atlas: { fixtureId: 'okie' },
      c4Level: 'context',
      selectedEntityId: 'system:okie',
      tourPlaying: false,
      enrichmentStatus: 'none',
      scanAvailable: false,
      askAvailable: true,
    });
    expect(result).toEqual(expect.not.objectContaining({
      apiKey: expect.anything(),
      token: expect.anything(),
      spend: expect.anything(),
      scanRoot: expect.anything(),
    }));
  });

  it('returns live selection and level after CLA-42 actions, not a stale register-time snapshot', async () => {
    const stale: AtlasPageContextInput = defaultContext();
    const { live } = bindFakeAtlas();
    const registerTool = vi.fn(async (tool: WebMcpTool) => tool);
    await registerWebMcpAtlasTools({ document: { modelContext: { registerTool } } });

    expect(await GET_ATLAS_CONTEXT_TOOL.execute({})).toMatchObject({
      c4Level: 'context',
      selectedEntityId: 'system:okie',
      tourPlaying: false,
      askAvailable: true,
    });

    await SET_C4_LEVEL_TOOL.execute({ level: 'L2' });
    await SELECT_ENTITY_TOOL.execute({ entityId: 'container:web-app' });
    await START_OVERVIEW_TOUR_TOOL.execute({});

    expect(live.c4Level).toBe('container');
    expect(live.selectedEntityId).toBe('container:web-app');
    expect(live.tourPlaying).toBe(true);

    const after = await GET_ATLAS_CONTEXT_TOOL.execute({});
    expect(after).toEqual({
      ok: true,
      tool: GET_ATLAS_CONTEXT_TOOL_NAME,
      atlas: { fixtureId: 'okie' },
      c4Level: 'container',
      selectedEntityId: 'container:web-app',
      tourPlaying: true,
      enrichmentStatus: 'none',
      scanAvailable: false,
      askAvailable: false,
    });
    expect(after).not.toEqual(expect.objectContaining({
      c4Level: stale.c4Level,
      selectedEntityId: stale.selectedEntityId,
      tourPlaying: stale.tourPlaying,
    }));
  });

  it('does not put secrets, spend, or private paths in names, descriptions, or results', async () => {
    bindFakeAtlas({
      readContext: () => ({
        ...defaultContext({ atlas: { owner: 'acme', repo: 'widgets' }, enrichmentStatus: 'complete' }),
        apiKey: PLANTED_SECRETS[0],
        token: PLANTED_SECRETS[1],
        OPENROUTER_API_KEY: PLANTED_SECRETS[0],
        GITHUB_TOKEN: PLANTED_SECRETS[1],
        scanRoot: '/var/okie/scan-root',
        spendLedger: { usd: 12.5 },
        repositoryRoot: '/home/ubuntu/okie',
      } as AtlasPageContextInput),
    });

    const result = await GET_ATLAS_CONTEXT_TOOL.execute({
      apiKey: PLANTED_SECRETS[0],
      token: 'gho_okieTestPlantedSecretCla40xxxx',
      scanRoot: '/tmp/private-scan',
    });
    expect(result).toEqual({
      ok: true,
      tool: GET_ATLAS_CONTEXT_TOOL_NAME,
      atlas: { owner: 'acme', repo: 'widgets' },
      c4Level: 'context',
      selectedEntityId: 'system:okie',
      tourPlaying: false,
      enrichmentStatus: 'complete',
      scanAvailable: false,
      askAvailable: true,
    });
    expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('scanRoot');
    expect(result).not.toHaveProperty('spendLedger');
    expect(result).not.toHaveProperty('repositoryRoot');

    const published = publicSurface(
      GET_ATLAS_CONTEXT_TOOL.name,
      GET_ATLAS_CONTEXT_TOOL.title,
      GET_ATLAS_CONTEXT_TOOL.description,
      GET_ATLAS_CONTEXT_TOOL.inputSchema,
      result,
      atlasPageContext({
        atlas: { fixtureId: 'okie' },
        c4Level: 'code',
        selectedEntityId: 'system:okie',
        tourPlaying: false,
        enrichmentStatus: 'skipped',
        scanAvailable: false,
        askAvailable: true,
      }),
    );
    expect(SECRET_LEAK.test(published)).toBe(false);
    for (const secret of PLANTED_SECRETS) {
      expect(published).not.toContain(secret);
    }
    expect(published).not.toContain('127.0.0.1:4180');
    expect(published).not.toContain('scanRoot');
    expect(published).not.toContain('/home/ubuntu');
    expect(published).not.toContain('spend');
  });

  it('maps share URLs to owner/repo and local pages to a fixture id', () => {
    expect(atlasIdentityFromLocation('/r/THISS/okie')).toEqual({ owner: 'THISS', repo: 'okie' });
    expect(atlasIdentityFromLocation('/r/acme/widgets', '?fixture=scan')).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(atlasIdentityFromLocation('/', '?fixture=okie')).toEqual({ fixtureId: 'okie' });
    expect(atlasIdentityFromLocation('/', '?fixture=stress')).toEqual({ fixtureId: 'stress' });
    expect(atlasIdentityFromLocation('/', '?fixture=scan:acme__widgets')).toEqual({ fixtureId: 'scan:acme__widgets' });
    expect(JSON.stringify([
      atlasIdentityFromLocation('/r/THISS/okie'),
      atlasIdentityFromLocation('/', '?fixture=okie'),
    ])).not.toMatch(/scanRoot|\/home\/|\/var\/|OPENROUTER|GITHUB_TOKEN/);
  });

  it('derives enrichment from loaded scene facts without spend or model id', () => {
    expect(atlasEnrichmentStatus({ atlasSource: 'golden', entities: [{ responsibility: 'Hosts the atlas.' }] })).toBe('none');
    expect(atlasEnrichmentStatus({ atlasSource: 'stress', entities: [] })).toBe('none');
    expect(atlasEnrichmentStatus({ atlasSource: 'imported-mermaid', entities: [{ responsibility: 'Box' }] })).toBe('none');
    expect(atlasEnrichmentStatus({
      atlasSource: 'scan',
      entities: [{ responsibility: 'No summary supplied.' }, { responsibility: '   ' }],
    })).toBe('skipped');
    expect(atlasEnrichmentStatus({
      atlasSource: 'scan',
      entities: [{ responsibility: 'Hosts the scan server.' }],
    })).toBe('complete');
    expect(JSON.stringify(atlasEnrichmentStatus({ atlasSource: 'scan', entities: [{ responsibility: 'Hosts the scan server.' }] }))).not.toMatch(/spend|usd|OPENROUTER|modelId|provider/i);
  });

  it('treats camera flight and arrival as tour playing, and paused/idle as not playing', () => {
    expect(atlasTourPlaying({ storyStep: -1, storyPlaying: false, storyPhase: 'idle' })).toBe(false);
    expect(atlasTourPlaying({ storyStep: 0, storyPlaying: false, storyPhase: 'paused' })).toBe(false);
    expect(atlasTourPlaying({ storyStep: 0, storyPlaying: true, storyPhase: 'hold' })).toBe(true);
    expect(atlasTourPlaying({ storyStep: 0, storyPlaying: false, storyPhase: 'flight' })).toBe(true);
    expect(atlasTourPlaying({ storyStep: 1, storyPlaying: false, storyPhase: 'arrival' })).toBe(true);
  });

  it('returns unavailable without throwing when atlas chrome is not bound', async () => {
    bindFakeAtlas().unbind();
    await expect(Promise.resolve(GET_ATLAS_CONTEXT_TOOL.execute({}))).resolves.toMatchObject({
      ok: false,
      isError: true,
      error: { code: 'unavailable' },
    });
  });
});
