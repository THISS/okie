# Source For Atlas plugin

Portable OpenAI plugin packaging for the existing five read-only Atlas MCP tools. It supports finding a published repository, explaining its architecture and following captured source evidence. No scans, mutations, private repositories or paid Ask submissions are included.

**Release state:** the public read-only endpoint `https://sourcefor.dev/mcp` was deployed and validated on 2026-10-03. A custom MCP plugin was installed in ChatGPT and completed an Ask architecture explanation with six captured, frozen-commit citations. That tools-only connection does not install this bundled skill. The personal archive was subsequently imported and installed in ChatGPT; a fresh chat launched from that package completed a pinned Ask explanation with seven captured source citations and a rendered Mermaid diagram. Portable Codex installation was validated separately. Installing a package does not deploy the service or enable paid Ask.

## Local installation

From a checkout containing this package:

```sh
codex plugin marketplace add .
codex plugin add sourcefor-atlas@sourcefor
```

The repo marketplace is `.agents/plugins/marketplace.json`. The installed plugin is cached; refresh/reinstall it after changing its files, then start a new session. Check `codex plugin list` to confirm its installation. Use a local checkout of this branch while the stacked PR is unmerged; switch to a pinned reviewed release for distribution.

Try: “Use Source For Atlas to find source-for/atlas and explain how Ask works. Include the atlas link, the version/commit, and captured source evidence.” The expected workflow is list → search → entity/relationships → evidence, with one immutable pin reused throughout.

## Planning a change

Try: “Use the source-for/atlas Atlas to plan cancellable Ask requests when I close the panel or switch maps. Identify affected contracts, implementation order, risks and validation.”

The planning workflow distinguishes captured current behavior from proposed changes, follows adjacent callers and consumers, and checks evidence across affected boundaries. When an authorized current checkout is available, compare relevant contracts with the publication's pinned commit before prescribing edits. Otherwise the plan stays provisional and names the checks an implementer needs. Published evidence alone cannot establish the current branch or exhaustive impact coverage.

Diagrams prefer short labels and top-to-bottom layout for chat width. Current behavior and proposed changes are shown separately. The 0.1.2 planning guidance requires updating the installed package; the prior ChatGPT installation validated 0.1.1. Updating repository files does not refresh ChatGPT's installed copy.

## ChatGPT

For the tested tools-only connection, enable developer mode, open Plugins → Add → Create custom MCP server, enter `https://sourcefor.dev/mcp`, choose no authentication, and create the plugin. Select Source For Atlas in a new chat and run the example workflow above. An icon is optional for this personal connection. Check all five read tools are discovered.

To bundle the skill with an existing registered ChatGPT connection, copy its technical ID from the plugin settings URL and build a personal archive:

```sh
node scripts/package-atlas-plugin.mjs /tmp/sourcefor-atlas-chatgpt.zip --chatgpt-app-id asdk_app_YOUR_REGISTERED_ID
```

The packager also accepts the settings URL's `plugin_asdk_app_...` identifier and removes only the `plugin_` wrapper. It generates `extensions.com.openai.apps` pointing at `./.app.json`, containing the registered server ID. It omits the portable MCP transport from this personal archive to avoid registering a second server. This ID is connection metadata, not a credential; do not commit a personal mapping to the shared package. The default archive remains portable and uses `mcp.json`.

Open Plugins → Add → Upload plugin archive, select the personal ZIP, review it and add it to your personal plugins. Then click the separate Install plugin button on its detail page and use Try in chat to start a fresh chat. This mapped archive path was validated in the test account with one connected app and the understand-atlas skill. A supported local/repo marketplace is an alternative. Public directory submission is a separate workflow; registered connection mappings are for local/workspace packages, not public submission. Availability varies by account and surface. No custom UI is bundled.

The intended public endpoint reads anonymous published data. Cloudflare Access on staging is a different boundary: ChatGPT's MCP OAuth flow does not automatically authenticate with an Access service-token pair or a browser Access cookie. Do not embed service tokens in a plugin manifest, ZIP, URL or prompt. The existing staging SDK smoke is not proof of an installed ChatGPT plugin connection.

## Staging Codex transport diagnostics

Codex standalone MCP configuration supports reading headers from environment variables:

```toml
[mcp_servers.atlas_staging]
url = "https://staging.sourcefor.dev/mcp"
env_http_headers = { "CF-Access-Client-Id" = "STAGING_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "STAGING_ACCESS_CLIENT_SECRET" }
```

Supply those variables only in the launching environment through the existing authorized secret workflow. This tests the Codex transport; it is not a plugin transport override. Plugin-scoped config controls tool enablement/approval policy, not the server URL/authentication. Do not copy this config into `mcp.json` or assume header interpolation is supported there.

## Limits and failures

The five shared reads have a separate 60-request/IP/minute limiter and no model calls. Keep the returned version pin; restart pagination if a listing changes or a cursor is rejected. Treat a 404 as unpublished/disabled rather than permission to scan. For Access login HTML or authorization errors, fix the connection boundary rather than retrying tool arguments. For rate limits, honor Retry-After. Missing, partial or stale evidence must stay explicit in answers.

## Maintenance and validation

Keep the manifest, skill and endpoint tool schemas aligned. Increment the plugin version for releases. Archive only the plugin directory, not the checkout or local settings. Inspect an archive before sharing; no credentials, caches, hooks or build dependencies are required. Test direct architecture questions, indirect questions, missing repositories, unavailable excerpts, stale pins and out-of-scope mutation requests in the target host. Target-platform validation remains mandatory before claiming the integration complete.

References: [OpenAI packaging](https://developers.openai.com/plugins/build/plugins), [authentication](https://developers.openai.com/plugins/build/auth), [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Atlas tools](https://staging.sourcefor.dev/docs/agents).

### Package an archive

With the system `zip` command installed, run from the repository root:

```sh
node scripts/package-atlas-plugin.mjs /tmp/sourcefor-atlas-0.1.2.zip
unzip -l /tmp/sourcefor-atlas-0.1.2.zip
```

The packager copies only the manifests, README and skill into a fresh archive. It requires the public endpoint and rejects embedded transport authentication.

### Validation performed for this change

Both manifests passed the published schema checks, and the skill passed its validator. An installed portable-only preview was tested in Codex CLI 0.159.3 against staging through a temporary loopback relay. The relay supplied Access headers outside the package and agent environment; the preview changed only the MCP URL. The full architecture workflow called all five tools and reused one immutable atlas pin. A citation audit found an initial response combining two disjoint excerpts into one wider link; the skill was tightened to require one captured excerpt per link. The installed-plugin rerun passed: all six source links fit retrieved excerpt ranges and frozen commits, with all five tools used and one pin reused. This validates the staging portable preview. After rollout, the production endpoint also passed initialization, all-five-tool discovery and a pinned evidence workflow.

Do not install the preview alongside the production package: both register the `atlas` server name, which can select the wrong transport. Remove the test installation and relay after QA. ChatGPT custom-connection validation passed on 2026-10-03: the installed plugin explained Ask using one publication pin and six source links. An independent `get_evidence` audit verified all six links fit captured excerpt ranges at the frozen commit. The activity panel showed investigation summaries rather than raw tool arguments, so the host's all-five-tool account is not a raw invocation trace. The response explicitly acknowledged missing component-level source evidence.

The test also exposed a missing visual Atlas link: repository URLs were mistaken for app URLs. The follow-up tool metadata adds `atlasUrl` and `atlasUrlVersion: "latest"` to distinguish the browser's latest publication from the immutable evidence pin. The bundled skill requires that distinction. Do not claim these fields are deployed until a later reviewed release is deployed.

The original portable archive upload returned a generic Add plugin failure before the endpoint rollout; its cause remains unknown. The personal 0.1.1 archive with the registered connection mapping successfully imported and installed on 2026-10-03. Its detail page showed one connected app and the understand-atlas skill; Try in chat selected the packaged plugin rather than the separate tools-only connection. The fresh-chat test completed an Ask explanation, seven commit-pinned source citations and a rendered Mermaid flowchart. It correctly reported that the live endpoint lacked atlasUrl. The host activity panel exposed retrieval summaries, not raw tool arguments or an explicit skill-load trace; do not claim stronger invocation proof. The diagram rendered correctly, although its horizontal seven-node layout was small at normal chat width.

Version 0.1.2 planning guidance passed an independent read-only evaluation against the public publication and current checkout: the agent distinguished existing browser abort behavior from proposed backend cancellation and found relevant drift. Broad-search noise led to container-narrowing guidance. See [the planning evaluation](../../docs/qa/atlas-plugin/planning.md) for scenarios, evidence and limits. This is separate from ChatGPT installation of 0.1.2, which remains pending.
