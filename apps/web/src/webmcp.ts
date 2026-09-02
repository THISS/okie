/**
 * WebMCP (CLA-40 + CLA-41): progressive enhancement so Chrome (and later
 * other browsers) can see Okie as a WebMCP provider.
 *
 * This is the in-page browser API (`document.modelContext`, with a fallback to
 * the Chrome origin-trial `navigator.modelContext`) — not a remote or stdio
 * MCP server. If the API is missing, registration is a silent no-op: no throw,
 * no extra chrome, no failed boot.
 *
 * CLA-40 probe tool `okie_probe`: a documented, read-only handshake with a
 * JSON Schema. Name, description, and result contain only public product facts.
 *
 * CLA-41 landing tools (`start_public_scan`, `open_share_atlas`): imperative
 * `registerTool` on `/new`, reusing this detect/register path. Declarative
 * HTML form tools do not fit this hosted chrome — `/new` is a React SPA that
 * POSTs JSON with the user's session cookie rather than a native form action,
 * and opening an atlas is navigation, not a form. Tools fill the paste box /
 * navigate so the user sees the same UI. Atlas actuation is CLA-42.
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

export const START_PUBLIC_SCAN_TOOL_NAME = 'start_public_scan';
export const START_PUBLIC_SCAN_TOOL_TITLE = 'Start a public scan';
export const START_PUBLIC_SCAN_TOOL_DESCRIPTION =
  'Fill the /new paste box and start a public GitHub repository scan with the signed-in user session. Same sign-in and quotas as submitting the form. Does not scan private repositories.';

export const OPEN_SHARE_ATLAS_TOOL_NAME = 'open_share_atlas';
export const OPEN_SHARE_ATLAS_TOOL_TITLE = 'Open a public atlas';
export const OPEN_SHARE_ATLAS_TOOL_DESCRIPTION =
  'Open a published public atlas at /r/owner/repo. Viewing does not require sign-in.';

export const LANDING_REPO_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    owner: {
      type: 'string',
      description: 'GitHub owner or organization login.',
    },
    repo: {
      type: 'string',
      description: 'GitHub repository name.',
    },
  },
  required: ['owner', 'repo'],
  additionalProperties: false,
} as const;

export type OkieProbeResult = {
  ok: true;
  product: 'Okie';
  provider: 'webmcp';
  tool: typeof OKIE_PROBE_TOOL_NAME;
};

export type WebMcpToolErrorCode = 'invalid_repo' | 'unauthorized' | 'unavailable' | 'submit_failed';

export type WebMcpToolError = {
  ok: false;
  isError: true;
  error: { code: WebMcpToolErrorCode; message: string };
};

export type StartPublicScanSuccess = {
  ok: true;
  tool: typeof START_PUBLIC_SCAN_TOOL_NAME;
  owner: string;
  repo: string;
  atlasPath: string;
};

export type OpenShareAtlasSuccess = {
  ok: true;
  tool: typeof OPEN_SHARE_ATLAS_TOOL_NAME;
  owner: string;
  repo: string;
  atlasPath: string;
};

export type StartPublicScanResult = StartPublicScanSuccess | WebMcpToolError;
export type OpenShareAtlasResult = OpenShareAtlasSuccess | WebMcpToolError;

export type WebMcpJsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

export type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: WebMcpJsonSchema;
  execute: (input?: Record<string, unknown>) => unknown | Promise<unknown>;
  annotations: { readOnlyHint: boolean };
};

export type WebMcpRegisterOptions = {
  signal?: AbortSignal;
};

export type WebMcpModelContext = {
  registerTool: (tool: WebMcpTool, options?: WebMcpRegisterOptions) => unknown;
};

export type WebMcpHost = {
  document?: unknown;
  navigator?: unknown;
};

export type WebMcpFoundationStatus = 'absent' | 'registered' | 'skipped';

export type ScanLandingActions = {
  fillRepoInput: (url: string) => void;
  submitScan: (url: string) => Promise<StartPublicScanResult>;
  openAtlas: (atlasPath: string) => void;
};

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;
const GITHUB_NAME_MAX = 100;

let landingActions: ScanLandingActions | undefined;

export function webMcpToolError(code: WebMcpToolErrorCode, message: string): WebMcpToolError {
  return { ok: false, isError: true, error: { code, message } };
}

export function publicGithubRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

export function publicAtlasPath(owner: string, repo: string): string {
  return `/r/${owner}/${repo}`;
}

export function publicScanFetchInit(url: string): RequestInit {
  return {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  };
}

/**
 * Map a hosted `POST /api/scans` HTTP status onto a public tool result.
 * Does not echo the response body — job JSON and server error strings stay
 * off the tool surface (they can carry enrichment notes or internals).
 */
export function startPublicScanResultFromHttp(status: number, body: unknown): StartPublicScanResult {
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const job = record.job;
  if (status >= 200 && status < 300 && job !== null && typeof job === 'object') {
    const accepted = job as Record<string, unknown>;
    if (
      typeof accepted.owner === 'string'
      && typeof accepted.repo === 'string'
      && typeof accepted.atlasPath === 'string'
    ) {
      return {
        ok: true,
        tool: START_PUBLIC_SCAN_TOOL_NAME,
        owner: accepted.owner,
        repo: accepted.repo,
        atlasPath: accepted.atlasPath,
      };
    }
  }
  if (status === 401) {
    return webMcpToolError(
      'unauthorized',
      'Sign in with GitHub to scan a repository. Viewing a published atlas stays public.',
    );
  }
  if (status === 422) {
    return webMcpToolError('invalid_repo', 'That does not look like a public GitHub repository.');
  }
  if (status === 429) {
    return webMcpToolError('submit_failed', 'Too many scans from this account; try again in a few minutes.');
  }
  return webMcpToolError('submit_failed', 'The scan could not be started.');
}

export function parsePublicRepoInput(input?: Record<string, unknown>): { owner: string; repo: string } | WebMcpToolError {
  const owner = typeof input?.owner === 'string' ? input.owner.trim() : '';
  const repo = typeof input?.repo === 'string' ? input.repo.trim() : '';
  if (
    !GITHUB_NAME.test(owner)
    || !GITHUB_NAME.test(repo)
    || owner.length > GITHUB_NAME_MAX
    || repo.length > GITHUB_NAME_MAX
    || owner === '.'
    || owner === '..'
    || repo === '.'
    || repo === '..'
  ) {
    return webMcpToolError('invalid_repo', 'Provide a GitHub owner and repository name.');
  }
  return { owner, repo };
}

export function bindScanLandingActions(actions: ScanLandingActions): () => void {
  landingActions = actions;
  return () => {
    if (landingActions === actions) landingActions = undefined;
  };
}

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

async function executeStartPublicScan(input?: Record<string, unknown>): Promise<StartPublicScanResult> {
  try {
    const parsed = parsePublicRepoInput(input);
    if ('error' in parsed) return parsed;
    const url = publicGithubRepoUrl(parsed.owner, parsed.repo);
    const actions = landingActions;
    if (!actions) {
      return webMcpToolError('unavailable', 'Open /new to start a public scan.');
    }
    actions.fillRepoInput(url);
    return await actions.submitScan(url);
  } catch {
    return webMcpToolError('submit_failed', 'Could not start the scan.');
  }
}

async function executeOpenShareAtlas(input?: Record<string, unknown>): Promise<OpenShareAtlasResult> {
  try {
    const parsed = parsePublicRepoInput(input);
    if ('error' in parsed) return parsed;
    const atlasPath = publicAtlasPath(parsed.owner, parsed.repo);
    const actions = landingActions;
    if (!actions) {
      return webMcpToolError('unavailable', 'Open /new to open a public atlas.');
    }
    actions.openAtlas(atlasPath);
    return {
      ok: true,
      tool: OPEN_SHARE_ATLAS_TOOL_NAME,
      owner: parsed.owner,
      repo: parsed.repo,
      atlasPath,
    };
  } catch {
    return webMcpToolError('submit_failed', 'Could not open the atlas.');
  }
}

export const START_PUBLIC_SCAN_TOOL: WebMcpTool = {
  name: START_PUBLIC_SCAN_TOOL_NAME,
  title: START_PUBLIC_SCAN_TOOL_TITLE,
  description: START_PUBLIC_SCAN_TOOL_DESCRIPTION,
  inputSchema: LANDING_REPO_INPUT_SCHEMA,
  execute: executeStartPublicScan,
  annotations: { readOnlyHint: false },
};

export const OPEN_SHARE_ATLAS_TOOL: WebMcpTool = {
  name: OPEN_SHARE_ATLAS_TOOL_NAME,
  title: OPEN_SHARE_ATLAS_TOOL_TITLE,
  description: OPEN_SHARE_ATLAS_TOOL_DESCRIPTION,
  inputSchema: LANDING_REPO_INPUT_SCHEMA,
  execute: executeOpenShareAtlas,
  annotations: { readOnlyHint: false },
};

export const LANDING_WEBMCP_TOOLS: readonly WebMcpTool[] = [START_PUBLIC_SCAN_TOOL, OPEN_SHARE_ATLAS_TOOL];

function asModelContext(value: unknown): WebMcpModelContext | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const registerTool = (value as { registerTool?: unknown }).registerTool;
  if (typeof registerTool !== 'function') return undefined;
  return value as WebMcpModelContext;
}

function readModelContext(host: unknown, key: 'document' | 'navigator'): unknown {
  if (host === null || typeof host !== 'object') return undefined;
  const container = (host as Record<string, unknown>)[key];
  if (container === null || typeof container !== 'object') return undefined;
  return (container as { modelContext?: unknown }).modelContext;
}

/**
 * Current spec surface is `document.modelContext`. Chrome 149 shipped
 * `navigator.modelContext` (deprecated in Chrome 150). Prefer document.
 */
export function detectModelContext(host: unknown = globalThis): WebMcpModelContext | undefined {
  try {
    const fromDocument = asModelContext(readModelContext(host, 'document'));
    if (fromDocument) return fromDocument;
    return asModelContext(readModelContext(host, 'navigator'));
  } catch {
    return undefined;
  }
}

async function registerTools(
  tools: readonly WebMcpTool[],
  host: unknown,
  options?: WebMcpRegisterOptions,
): Promise<WebMcpFoundationStatus> {
  try {
    const context = detectModelContext(host);
    if (!context) return 'absent';
    for (const tool of tools) {
      if (options) await Promise.resolve(context.registerTool(tool, options));
      else await Promise.resolve(context.registerTool(tool));
    }
    return 'registered';
  } catch {
    return 'skipped';
  }
}

export async function registerWebMcpFoundation(
  host: unknown = globalThis,
): Promise<WebMcpFoundationStatus> {
  return registerTools([OKIE_PROBE_TOOL], host);
}

export async function registerWebMcpLandingTools(
  host: unknown = globalThis,
  options?: WebMcpRegisterOptions,
): Promise<WebMcpFoundationStatus> {
  return registerTools(LANDING_WEBMCP_TOOLS, host, options);
}
