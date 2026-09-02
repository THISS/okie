/**
 * WebMCP (CLA-40 + CLA-41 + CLA-42): progressive enhancement so Chrome (and
 * later other browsers) can see Okie as a WebMCP provider.
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
 * navigate so the user sees the same UI.
 *
 * CLA-42 atlas tools (`set_c4_level`, `select_entity`, `isolate`,
 * `start_overview_tour`, `ask_atlas`): imperative `registerTool` on a loaded
 * atlas (`/` local fixture and `/r/:owner/:repo`). Each calls the same store
 * actions the chrome already uses. No new backend. Unknown entity/level is a
 * structured tool error, never a throw. `ask_atlas` opens the Ask popover and
 * may fill the query; it does not start a live paid answer.
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

export const SET_C4_LEVEL_TOOL_NAME = 'set_c4_level';
export const SET_C4_LEVEL_TOOL_TITLE = 'Set C4 level';
export const SET_C4_LEVEL_TOOL_DESCRIPTION =
  'Switch the loaded atlas to a C4 band: context (L1), container (L2), component (L3), or code (L4). Same as the level rail.';

export const SELECT_ENTITY_TOOL_NAME = 'select_entity';
export const SELECT_ENTITY_TOOL_TITLE = 'Select entity';
export const SELECT_ENTITY_TOOL_DESCRIPTION =
  'Select an entity on the loaded atlas and open its inspector. Same as picking a node on the map.';

export const ISOLATE_TOOL_NAME = 'isolate';
export const ISOLATE_TOOL_TITLE = 'Isolate focus';
export const ISOLATE_TOOL_DESCRIPTION =
  'Isolate the focused context on the loaded atlas, or restore the full view. Same as Isolate focus / Restore full view.';

export const START_OVERVIEW_TOUR_TOOL_NAME = 'start_overview_tour';
export const START_OVERVIEW_TOUR_TOOL_TITLE = 'Start overview tour';
export const START_OVERVIEW_TOUR_TOOL_DESCRIPTION =
  'Start the saved overview guided story on the loaded atlas. Same as the story launcher.';

export const ASK_ATLAS_TOOL_NAME = 'ask_atlas';
export const ASK_ATLAS_TOOL_TITLE = 'Ask Atlas';
export const ASK_ATLAS_TOOL_DESCRIPTION =
  'Open the Ask Atlas popover on the loaded atlas and optionally fill the question. Does not submit a live paid answer.';

export const C4_LEVELS = ['context', 'container', 'component', 'code'] as const;
export type C4Level = (typeof C4_LEVELS)[number];

export const SET_C4_LEVEL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    level: {
      type: 'string',
      description: 'C4 band: context, container, component, or code. L1–L4 aliases are also accepted.',
      enum: ['context', 'container', 'component', 'code', 'L1', 'L2', 'L3', 'L4'],
    },
  },
  required: ['level'],
  additionalProperties: false,
} as const;

export const SELECT_ENTITY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    entityId: {
      type: 'string',
      description: 'Entity id on this atlas, for example system:okie.',
    },
  },
  required: ['entityId'],
  additionalProperties: false,
} as const;

export const ISOLATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    entityId: {
      type: 'string',
      description: 'Optional entity to select before isolating. Defaults to the current selection.',
    },
    active: {
      type: 'boolean',
      description: 'When false, restore the full architecture view. Defaults to true.',
    },
  },
  additionalProperties: false,
} as const;

export const START_OVERVIEW_TOUR_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const ASK_ATLAS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'Optional question to put in the Ask Atlas field. Not submitted.',
    },
  },
  additionalProperties: false,
} as const;

export type OkieProbeResult = {
  ok: true;
  product: 'Okie';
  provider: 'webmcp';
  tool: typeof OKIE_PROBE_TOOL_NAME;
};

export type WebMcpToolErrorCode =
  | 'invalid_repo'
  | 'unauthorized'
  | 'unavailable'
  | 'submit_failed'
  | 'unknown_entity'
  | 'unknown_level';

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

export type SetC4LevelSuccess = {
  ok: true;
  tool: typeof SET_C4_LEVEL_TOOL_NAME;
  level: C4Level;
};

export type SelectEntitySuccess = {
  ok: true;
  tool: typeof SELECT_ENTITY_TOOL_NAME;
  entityId: string;
};

export type IsolateSuccess = {
  ok: true;
  tool: typeof ISOLATE_TOOL_NAME;
  visibilityMode: 'isolate' | 'all';
};

export type StartOverviewTourSuccess = {
  ok: true;
  tool: typeof START_OVERVIEW_TOUR_TOOL_NAME;
  step: 0;
};

export type AskAtlasSuccess = {
  ok: true;
  tool: typeof ASK_ATLAS_TOOL_NAME;
  open: true;
};

export type SetC4LevelResult = SetC4LevelSuccess | WebMcpToolError;
export type SelectEntityResult = SelectEntitySuccess | WebMcpToolError;
export type IsolateResult = IsolateSuccess | WebMcpToolError;
export type StartOverviewTourResult = StartOverviewTourSuccess | WebMcpToolError;
export type AskAtlasResult = AskAtlasSuccess | WebMcpToolError;

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

export type AtlasChromeActions = {
  hasEntity: (entityId: string) => boolean;
  selectEntity: (entityId: string) => void;
  setC4Level: (level: C4Level) => void;
  isolate: (active: boolean) => void;
  startOverviewTour: () => void;
  openAsk: (question: string) => void;
};

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;
const GITHUB_NAME_MAX = 100;
const ENTITY_ID_MAX = 200;
const ASK_QUESTION_MAX = 2_000;

const C4_LEVEL_BY_ALIAS: Record<string, C4Level> = {
  context: 'context',
  container: 'container',
  component: 'component',
  code: 'code',
  l1: 'context',
  l2: 'container',
  l3: 'component',
  l4: 'code',
};

let landingActions: ScanLandingActions | undefined;
let atlasActions: AtlasChromeActions | undefined;

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

export function bindAtlasChromeActions(actions: AtlasChromeActions): () => void {
  atlasActions = actions;
  return () => {
    if (atlasActions === actions) atlasActions = undefined;
  };
}

export function parseC4LevelInput(input?: Record<string, unknown>): { level: C4Level } | WebMcpToolError {
  const raw = typeof input?.level === 'string' ? input.level.trim() : '';
  const level = C4_LEVEL_BY_ALIAS[raw.toLowerCase()];
  if (!level) {
    return webMcpToolError('unknown_level', 'Provide a C4 level: context, container, component, or code.');
  }
  return { level };
}

export function parseEntityIdInput(input?: Record<string, unknown>, key = 'entityId'): { entityId: string } | WebMcpToolError {
  const raw = typeof input?.[key] === 'string' ? input[key].trim() : '';
  if (!raw || raw.length > ENTITY_ID_MAX) {
    return webMcpToolError('unknown_entity', 'That entity is not on this atlas.');
  }
  return { entityId: raw };
}

function optionalEntityIdInput(input?: Record<string, unknown>): { entityId?: string } | WebMcpToolError {
  if (input?.entityId === undefined) return {};
  return parseEntityIdInput(input);
}

function optionalAskQuestion(input?: Record<string, unknown>): string {
  if (typeof input?.question !== 'string') return '';
  return input.question.trim().slice(0, ASK_QUESTION_MAX);
}

function atlasUnavailable(): WebMcpToolError {
  return webMcpToolError('unavailable', 'Open a loaded atlas to use this tool.');
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

function executeSetC4Level(input?: Record<string, unknown>): SetC4LevelResult {
  try {
    const parsed = parseC4LevelInput(input);
    if ('error' in parsed) return parsed;
    const actions = atlasActions;
    if (!actions) return atlasUnavailable();
    actions.setC4Level(parsed.level);
    return { ok: true, tool: SET_C4_LEVEL_TOOL_NAME, level: parsed.level };
  } catch {
    return webMcpToolError('unavailable', 'Could not change the C4 level.');
  }
}

function executeSelectEntity(input?: Record<string, unknown>): SelectEntityResult {
  try {
    const parsed = parseEntityIdInput(input);
    if ('error' in parsed) return parsed;
    const actions = atlasActions;
    if (!actions) return atlasUnavailable();
    if (!actions.hasEntity(parsed.entityId)) {
      return webMcpToolError('unknown_entity', 'That entity is not on this atlas.');
    }
    actions.selectEntity(parsed.entityId);
    return { ok: true, tool: SELECT_ENTITY_TOOL_NAME, entityId: parsed.entityId };
  } catch {
    return webMcpToolError('unavailable', 'Could not select that entity.');
  }
}

function executeIsolate(input?: Record<string, unknown>): IsolateResult {
  try {
    const parsed = optionalEntityIdInput(input);
    if ('error' in parsed) return parsed;
    const actions = atlasActions;
    if (!actions) return atlasUnavailable();
    if (parsed.entityId !== undefined) {
      if (!actions.hasEntity(parsed.entityId)) {
        return webMcpToolError('unknown_entity', 'That entity is not on this atlas.');
      }
      actions.selectEntity(parsed.entityId);
    }
    const active = input?.active !== false;
    actions.isolate(active);
    return { ok: true, tool: ISOLATE_TOOL_NAME, visibilityMode: active ? 'isolate' : 'all' };
  } catch {
    return webMcpToolError('unavailable', 'Could not change isolate.');
  }
}

function executeStartOverviewTour(input?: Record<string, unknown>): StartOverviewTourResult {
  try {
    void input;
    const actions = atlasActions;
    if (!actions) return atlasUnavailable();
    actions.startOverviewTour();
    return { ok: true, tool: START_OVERVIEW_TOUR_TOOL_NAME, step: 0 };
  } catch {
    return webMcpToolError('unavailable', 'Could not start the overview tour.');
  }
}

function executeAskAtlas(input?: Record<string, unknown>): AskAtlasResult {
  try {
    const actions = atlasActions;
    if (!actions) return atlasUnavailable();
    actions.openAsk(optionalAskQuestion(input));
    return { ok: true, tool: ASK_ATLAS_TOOL_NAME, open: true };
  } catch {
    return webMcpToolError('unavailable', 'Could not open Ask Atlas.');
  }
}

export const SET_C4_LEVEL_TOOL: WebMcpTool = {
  name: SET_C4_LEVEL_TOOL_NAME,
  title: SET_C4_LEVEL_TOOL_TITLE,
  description: SET_C4_LEVEL_TOOL_DESCRIPTION,
  inputSchema: SET_C4_LEVEL_INPUT_SCHEMA,
  execute: executeSetC4Level,
  annotations: { readOnlyHint: false },
};

export const SELECT_ENTITY_TOOL: WebMcpTool = {
  name: SELECT_ENTITY_TOOL_NAME,
  title: SELECT_ENTITY_TOOL_TITLE,
  description: SELECT_ENTITY_TOOL_DESCRIPTION,
  inputSchema: SELECT_ENTITY_INPUT_SCHEMA,
  execute: executeSelectEntity,
  annotations: { readOnlyHint: false },
};

export const ISOLATE_TOOL: WebMcpTool = {
  name: ISOLATE_TOOL_NAME,
  title: ISOLATE_TOOL_TITLE,
  description: ISOLATE_TOOL_DESCRIPTION,
  inputSchema: ISOLATE_INPUT_SCHEMA,
  execute: executeIsolate,
  annotations: { readOnlyHint: false },
};

export const START_OVERVIEW_TOUR_TOOL: WebMcpTool = {
  name: START_OVERVIEW_TOUR_TOOL_NAME,
  title: START_OVERVIEW_TOUR_TOOL_TITLE,
  description: START_OVERVIEW_TOUR_TOOL_DESCRIPTION,
  inputSchema: START_OVERVIEW_TOUR_INPUT_SCHEMA,
  execute: executeStartOverviewTour,
  annotations: { readOnlyHint: false },
};

export const ASK_ATLAS_TOOL: WebMcpTool = {
  name: ASK_ATLAS_TOOL_NAME,
  title: ASK_ATLAS_TOOL_TITLE,
  description: ASK_ATLAS_TOOL_DESCRIPTION,
  inputSchema: ASK_ATLAS_INPUT_SCHEMA,
  execute: executeAskAtlas,
  annotations: { readOnlyHint: false },
};

export const ATLAS_WEBMCP_TOOLS: readonly WebMcpTool[] = [
  SET_C4_LEVEL_TOOL,
  SELECT_ENTITY_TOOL,
  ISOLATE_TOOL,
  START_OVERVIEW_TOUR_TOOL,
  ASK_ATLAS_TOOL,
];

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

export async function registerWebMcpAtlasTools(
  host: unknown = globalThis,
  options?: WebMcpRegisterOptions,
): Promise<WebMcpFoundationStatus> {
  return registerTools(ATLAS_WEBMCP_TOOLS, host, options);
}
