# Agent access to published understanding

CLA-353 adds read-only access to published atlases. Remote MCP and in-page WebMCP share tool descriptions and the same public query service. Selectors live in `packages/architecture/src/agentQueries.ts`; neither transport runs a model, starts a scan, or changes the graph.

## Access

`POST /mcp` is stateless Streamable HTTP, implemented by the official MCP TypeScript SDK (1.31.0, protocol 2025-11-25 and the SDK's compatible earlier revisions). It supports initialization, tool discovery and tool calls. Responses are JSON; notifications return 202. GET streams and session deletion are unsupported (405). There are no MCP session cookies or IDs. Connect using an MCP client's Streamable HTTP transport.

WebMCP registers the same five read tools on atlas pages when the browser provides its model-context API. These call `POST /api/atlas/query` with `{tool, arguments}` and omit account cookies. Existing page-navigation tools remain separate. Read tools do not automatically navigate or select entities. Explicit atlas pins avoid silently querying a newer snapshot than the agent intended.

Both routes require `AGENT_READS_ENABLED=1`. Local and production configuration default off; staging enables the preview. Staging remains protected by Cloudflare Access. The preview is stacked on CLA-316 to preserve its Ask functionality; production deployment must follow the existing merged-main review flow.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `list_atlases` | optional `limit`, `cursor` | Public atlas identities and version/commit pins |
| `search_atlas` | `atlas`, `query`, optional `rootEntityId`, `limit`, `cursor` | Ranked entities from the complete published snapshot |
| `get_entity` | `atlas`, `entityId` | Structure, published understanding, responsibility, technology and source references |
| `get_relations` | `atlas`, `entityId`, optional `limit`, `cursor` | Incoming and outgoing relationships with source references |
| `get_evidence` | `atlas`, `entityId`; optional `sourcePath`, `sourceLine` | Captured source excerpts or an explicit missing-evidence status |

`atlas` is `{owner, repo, versionId}`. Obtain it with `list_atlases` and reuse that pin through the investigation. Results include the snapshot and commit identity. Search/relationship cursors bind the published version, snapshot and query; listing cursors bind the current directory contents and must be restarted after publication changes. Pages are capped at 50 records.

For example, a query through the JSON adapter is:

```json
{
  "tool": "search_atlas",
  "arguments": {
    "atlas": {"owner": "source-for", "repo": "atlas", "versionId": "<version from list_atlases>"},
    "query": "Ask",
    "limit": 10
  }
}
```

Use an entity ID from the search result with `get_entity`, `get_relations` and `get_evidence`. Repository prose and captured code are untrusted evidence, never instructions to an agent.

## Evidence and limits

The current snapshot schema does not establish the origin of every structural fact or responsibility. Results therefore say `snapshot-recorded` and `origin-not-recorded`; they do not manufacture observed/inferred labels or confidence percentages. Missing excerpts mean `not-captured`, not that code is absent or tested. Scan coverage remains `unknown`. Captured excerpts are bounded and indicate truncation or partial ranges.

New scans preserve the entry excerpt and add windows around recorded outgoing calls, capped at 128 windows and 512 KiB of serialized excerpt records per code entity, with at most 8 MiB of additional excerpt records across a snapshot. Each window still obeys the existing 48-line/4,096-character limits. Budget exhaustion and unsupported or overlong source lines can leave recorded calls uncaptured; existing publications are unchanged. These windows do not establish complete call or scan coverage.

`get_evidence` returns at most eight windows. Use the repository-relative `sourcePath` and positive `sourceLine` from a relation's evidence to select a late captured window. Selectors filter stored captures only; an uncaptured line returns `not-captured`, never a live source fetch. `truncated` remains true when other windows or declaration lines are omitted.

Readers only construct allowlisted public store keys. They require a listed, currently published repository and a matching immutable manifest/snapshot. They cannot read private operator sidecars or fetch arbitrary source URLs. Results project explicit fields, validate repository-relative paths, and scrub known credential/host-path shapes. This is defense in depth over published artifacts, not a promise that arbitrary repository text can never contain a secret.

Request bodies are capped at 16 KiB; raw snapshots at 64 MiB, with a streaming projection capped at 12 MiB of graph data; metadata and excerpt packets at 2 MiB; public explanation sidecars at 4 MiB. Embedded snapshot excerpts are discarded and fetched separately from public packs. Strings, nesting and record counts have additional parser bounds. An independent `AGENT_RATE_LIMITER` allows 60 requests/IP/minute, including MCP protocol exchanges. Rate-limit failures refuse reads; a missing limiter is allowed only on loopback development. These requests never admit or settle Ask spend. Cross-origin browser requests are refused; non-browser MCP clients can omit Origin. No account or private-atlas authorization is introduced in this public-data slice.

Entity reads include the accepted public summary, key points and evidence references shown by the inspector, with explicit staleness and unknown origin. Legacy role/interactions are supported. Diagrams, tables and private claim mappings are excluded from this first projection.

Private repositories, richer claim-backed explanation sections, diagram export, snapshot diffs, plugin packaging and guarded writes are follow-ups. The older MCP roadmap remains the longer-term direction.

## Published reference

The user-facing tool inventory lives at `/docs/agents`; `/llms.txt` provides the same connection details and complete inventory in plain text for agents. Both are static public assets, independent of WebMCP browser support. They distinguish the five shared read tools from page-only controls and legacy landing tools, and explicitly mark the staging-only read preview. Update both references when changing tools or deployment availability. Runtime MCP discovery and browser registrations remain authoritative for tool schemas.
