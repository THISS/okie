import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  OKIE_PROBE_INPUT_SCHEMA,
  OKIE_PROBE_TOOL,
  OKIE_PROBE_TOOL_DESCRIPTION,
  OKIE_PROBE_TOOL_NAME,
  WEBMCP_HOST_HEADERS,
  detectModelContext,
  okieProbeResult,
  registerWebMcpFoundation,
  type WebMcpTool,
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
    const host = {
      get document() {
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
      readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(webSrc).not.toMatch(/document\.domain\s*=/);
    expect(webSrc).not.toMatch(/Origin-Agent-Cluster['":\s]+\?0/);
    expect(webSrc).not.toMatch(/tools=\(\*\)|tools=\*|allow=["'][^"']*tools/);
  });

  it('wires detection into hosted chrome boot and host headers', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('registerWebMcpFoundation');
    expect(main).not.toMatch(/start_public_scan|open_share_atlas|okie_select|okie_isolate/);

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
