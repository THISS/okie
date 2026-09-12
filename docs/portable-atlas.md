# Local scans and the portable viewer

Portable v1 reads a committed Git revision, builds a deterministic atlas, and opens it in a static browser application. One repository is open at a time. No application server or LLM is required.

## Build and install the CLI locally

From the Okie checkout, with its dependencies installed:

```sh
pnpm package:cli
cd dist/okie-cli
npm pack
```

Install that tarball into your preferred local tools directory with npm. For example, `npm install --prefix /tmp/okie-tools /absolute/path/to/okie-scan-0.1.0.tgz` installs the executable at `/tmp/okie-tools/node_modules/.bin/okie-scan`. Add that bin directory to PATH for the commands below. Nothing in these steps publishes a package.

The package includes the three reusable skills under `skills/`: `okie-scan`, `okie-enrich`, and `okie-package`. Point your agent at the relevant `SKILL.md`, or copy its directory into your agent's supported skill location. The CLI requires Node 22+ and Git. Its npm dependencies include the TypeScript compiler and native Rust syntax parser. Rust semantic indexing additionally needs `rust-analyzer` and `rust-src` from a matching Rust toolchain.

## Scan a committed repository

```sh
okie-scan --source /path/to/repo --revision HEAD --full \
  --out /path/to/scan --emit-prompt /path/to/prompts
```

The scan materializes raw committed Git blobs in a temporary tree. It leaves local edits and untracked files alone and excludes them from the artifact. Source identity, evidence, excerpts and links all refer to the selected commit. V1 does not scan uncommitted snapshots. Acquisition currently requires materialized files; repositories containing symlinks or submodules produce an explicit unsupported-source error.

Open `/path/to/scan/atlas.okie.json` in the portable viewer. Existing snapshot/view/story outputs are also retained. Add `--include-source` to bundle full referenced source files; excerpts are included by default. Use `--repository-url https://github.com/owner/repo` for a local repository's source links. GitHub sources such as `--source gh:owner/repo@revision` include their canonical URL automatically.

`--full` requests TypeScript/JavaScript semantic resolution and Rust SCIP indexing. Missing package dependencies, configuration, inactive Rust targets or unavailable tooling can leave gaps. The isolated committed tree does not borrow potentially dirty workspace dependencies. Inspect `analysis.adapters[].limitations`, also available from the viewer's Analysis coverage disclosure. `--quick` explicitly uses syntax-only extraction. A reference is not automatically classified as a call; absent edges do not establish that code is unused. Python and Go semantic adapters are deferred.

## Optional enrichment

Load the `okie-enrich` skill with the original artifact, emitted prompts and matching repository. It guides the agent to add grounded descriptions in packet-named extraction documents. Merge those documents without rescanning:

```sh
okie-scan enrich --bundle /path/to/scan/atlas.okie.json \
  --docs /path/to/enrichment-docs --out /path/to/enriched.okie.json
```

Read the generated enrichment report next to the output. Invalid scopes are rejected and remain deterministic. The CLI command itself does not call an LLM; authoring the documents consumes agent capacity. Retaining prompts allows subsequent enrichment without another scan.

## Build a static viewer

From the Okie checkout:

```sh
pnpm build:portable
```

Serve `apps/web/dist-portable` with a static HTTP server to open the empty viewer and its local file picker/drop zone. Files are read in the browser. Browser storage is optional convenience storage; retain the JSON artifact as the durable copy. Replace opens another scan. Forget closes the active atlas and attempts to remove its remembered copy.

For a viewer that opens a bundled atlas directly:

```sh
okie-scan export --bundle /path/to/scan/atlas.okie.json \
  --viewer /path/to/okie/apps/web/dist-portable --out /path/to/empty-site
python3 -m http.server 4175 --directory /path/to/empty-site
```

Open `http://localhost:4175`. The relative asset build also supports hosting under a subdirectory. Use HTTP hosting; direct `file://` opening is not supported. Each packaged directory and artifact version has its own browser storage slot, so a remembered scan cannot replace another site's packaged atlas accidentally.

The source tab shows frozen excerpts immediately and can display bundled full files. If an exact GitHub source URL is available, retrieval is an explicit user action. Hosted sign-in and Ask actions are omitted in portable mode. Exporting a folder does not upload or publish it.

## Artifact compatibility

The artifact is UTF-8 JSON with `format: "okie-atlas"` and `version: 1`. It contains the pinned repository identity, semantic snapshot, view, story catalog, analyzer coverage and optional full-file `sources`. Renderer scenes are compiled by the viewer from those semantic inputs. Source excerpts remain on snapshot entities whether or not full files are included.

V1 imports are capped at 128 MiB and validated before compilation or persistence. Unsupported format versions, malformed model fields, unsafe file paths and mixed source revisions are rejected with an error. There is no implicit migration or best-effort version coercion. Future incompatible formats require a new version and an explicit validated migration or a matching viewer; retain the original artifact rather than rewriting it in place.
