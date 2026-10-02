# Source For Atlas plugin

Portable OpenAI plugin packaging for the existing five read-only Atlas MCP tools. It supports finding a published repository, explaining its architecture and following captured source evidence. No scans, mutations, private repositories or paid Ask submissions are included.

**Release state:** the package points at `https://sourcefor.dev/mcp`, where agent reads currently remain disabled. Installing the package does not enable the service. Public ChatGPT connection and production end-to-end validation require the reviewed Ask/agent-access release first. Do not describe this package as a published or usable production integration yet.

## Local installation

From a checkout containing this package:

```sh
codex plugin marketplace add .
codex plugin add sourcefor-atlas@sourcefor
```

The repo marketplace is `.agents/plugins/marketplace.json`. The installed plugin is cached; refresh/reinstall it after changing its files, then start a new session. Check `codex plugin list` to confirm its installation. Use a local checkout of this branch while the stacked PR is unmerged; switch to a pinned reviewed release for distribution.

Try: “Use Source For Atlas to find source-for/atlas and explain how Ask works. Include the atlas link, the version/commit, and captured source evidence.” The expected workflow is list → search → entity/relationships → evidence, with one immutable pin reused throughout.

## ChatGPT

After the endpoint release, connect `https://sourcefor.dev/mcp` through ChatGPT developer mode and test tool discovery and representative workflows. A packaged plugin can be tested through a local/repo marketplace on supported desktop surfaces; public directory submission is separate and is not performed by this PR. Availability varies by product/account. No custom UI is bundled.

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
node scripts/package-atlas-plugin.mjs /tmp/sourcefor-atlas-0.1.0.zip
unzip -l /tmp/sourcefor-atlas-0.1.0.zip
```

The packager copies only the manifests, README and skill into a fresh archive. It requires the public endpoint and rejects embedded transport authentication.

### Validation performed for this change

Both manifests passed the published schema checks, and the skill passed its validator. An installed portable-only preview was tested in Codex CLI 0.159.3 against staging through a temporary loopback relay. The relay supplied Access headers outside the package and agent environment; the preview changed only the MCP URL. The full architecture workflow called all five tools, reused one immutable atlas pin and returned commit-pinned source citations. This validates the staging preview, not the disabled production endpoint or ChatGPT.

Do not install the preview alongside the production package: both register the `atlas` server name, which can select the wrong transport. Remove the test installation and relay after QA. ChatGPT validation remains pending; desktop automation was unavailable in the test environment.
