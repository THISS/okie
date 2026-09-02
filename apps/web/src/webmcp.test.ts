import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LANDING_REPO_INPUT_SCHEMA,
  LANDING_WEBMCP_TOOLS,
  OKIE_PROBE_INPUT_SCHEMA,
  OKIE_PROBE_TOOL,
  OKIE_PROBE_TOOL_DESCRIPTION,
  OKIE_PROBE_TOOL_NAME,
  OPEN_SHARE_ATLAS_TOOL,
  OPEN_SHARE_ATLAS_TOOL_NAME,
  START_PUBLIC_SCAN_TOOL,
  START_PUBLIC_SCAN_TOOL_NAME,
  WEBMCP_HOST_HEADERS,
  bindScanLandingActions,
  detectModelContext,
  okieProbeResult,
  parsePublicRepoInput,
  publicAtlasPath,
  publicGithubRepoUrl,
  publicScanFetchInit,
  registerWebMcpFoundation,
  registerWebMcpLandingTools,
  startPublicScanResultFromHttp,
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
    expect(main).not.toMatch(/registerWebMcpLandingTools|start_public_scan|open_share_atlas|okie_select|okie_isolate/);

    const landing = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(landing).toContain('registerWebMcpLandingTools');
    expect(landing).toContain('bindScanLandingActions');
    expect(landing).toContain('publicScanFetchInit');
    expect(landing).not.toMatch(/okie_select|okie_isolate|okie_level|okie_tour|okie_ask/);
    expect(landing).not.toMatch(/document\.domain\s*=/);

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
