/**
 * WebMCP foundation (CLA-40): progressive enhancement so Chrome (and later
 * other browsers) can see Okie as a WebMCP provider.
 *
 * This is the in-page browser API (`document.modelContext`, with a fallback to
 * the Chrome origin-trial `navigator.modelContext`) — not a remote or stdio
 * MCP server. If the API is missing, registration is a silent no-op: no throw,
 * no extra chrome, no failed boot.
 *
 * Probe tool `okie_probe`: a documented, read-only handshake with a JSON
 * Schema. Name, description, and result contain only public product facts.
 * Landing scan tools and atlas actuation are later tickets (CLA-41, CLA-42).
 *
 * Origin isolation: never assign `document.domain`. Hosted chrome sends
 * `Permissions-Policy: tools=(self)` and `Origin-Agent-Cluster: ?1`. Do not
 * widen `tools` unless we later embed ourselves.
 *
 * Refs: https://developer.chrome.com/docs/ai/webmcp
 *       https://webmachinelearning.github.io/webmcp/
 */

/** Permissions-Policy + origin-keyed agent cluster for hosted chrome. */
export const WEBMCP_HOST_HEADERS = {
  'Permissions-Policy': 'tools=(self)',
  'Origin-Agent-Cluster': '?1',
} as const;

export const OKIE_PROBE_TOOL_NAME = 'okie_probe';
export const OKIE_PROBE_TOOL_TITLE = 'Okie probe';
export const OKIE_PROBE_TOOL_DESCRIPTION =
  'Confirms this Okie page is a WebMCP provider. Returns only public product facts. Does not start a scan, open an atlas, or change the page.';

export const OKIE_PROBE_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export type OkieProbeResult = {
  ok: true;
  product: 'Okie';
  provider: 'webmcp';
  tool: typeof OKIE_PROBE_TOOL_NAME;
};

export type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: typeof OKIE_PROBE_INPUT_SCHEMA;
  execute: (input?: Record<string, unknown>) => OkieProbeResult;
  annotations: { readOnlyHint: true };
};

export type WebMcpModelContext = {
  registerTool: (tool: WebMcpTool, options?: unknown) => unknown;
};

export type WebMcpHost = {
  document?: { modelContext?: unknown };
  navigator?: { modelContext?: unknown };
};

export type WebMcpFoundationStatus = 'absent' | 'registered' | 'skipped';

export function okieProbeResult(): OkieProbeResult {
  return {
    ok: true,
    product: 'Okie',
    provider: 'webmcp',
    tool: OKIE_PROBE_TOOL_NAME,
  };
}

export const OKIE_PROBE_TOOL: WebMcpTool = {
  name: OKIE_PROBE_TOOL_NAME,
  title: OKIE_PROBE_TOOL_TITLE,
  description: OKIE_PROBE_TOOL_DESCRIPTION,
  inputSchema: OKIE_PROBE_INPUT_SCHEMA,
  execute: () => okieProbeResult(),
  annotations: { readOnlyHint: true },
};

function asModelContext(value: unknown): WebMcpModelContext | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const registerTool = (value as { registerTool?: unknown }).registerTool;
  if (typeof registerTool !== 'function') return undefined;
  return value as WebMcpModelContext;
}

/**
 * Current spec surface is `document.modelContext`. Chrome 149 shipped
 * `navigator.modelContext` (deprecated in Chrome 150). Prefer document.
 */
export function detectModelContext(host: WebMcpHost = globalThis): WebMcpModelContext | undefined {
  try {
    const fromDocument = asModelContext(host.document?.modelContext);
    if (fromDocument) return fromDocument;
    return asModelContext(host.navigator?.modelContext);
  } catch {
    return undefined;
  }
}

export async function registerWebMcpFoundation(
  host: WebMcpHost = globalThis,
): Promise<WebMcpFoundationStatus> {
  try {
    const context = detectModelContext(host);
    if (!context) return 'absent';
    await Promise.resolve(context.registerTool(OKIE_PROBE_TOOL));
    return 'registered';
  } catch {
    return 'skipped';
  }
}
