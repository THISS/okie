# CLA-132 durable operator foundation

`OperatorStore` stores secret-free workflow metadata under `<scanRoot>/operator-v1`.
Its state file is replaced with an atomic rename; immutable artifact files are first
written to a private temporary directory and then renamed into their revision
directory. Artifact revision IDs are independent from source commits.

On construction, queued/running runs and attempts become `interrupted`. An operator
can decide whether to resume them; the store never silently reports them complete.
Draft artifact content and accepted explanations are append-only. A retry creates a
new attempt and explanation version, then a later artifact/draft revision assembles
the selected output. Frozen drafts therefore cannot be changed by late work.

`OperatorPublicationService` freezes an open draft only when the client supplies the
current publication version it reviewed. It rejects stale publishes and requires an
explicit coverage acknowledgement for failed, stale, or incomplete enrichment. The
current pointer is a small JSON file atomically renamed after a publication record is
created. Consumers resolve the pointer once and use its immutable artifact revision
for every resource in that page load.

Existing `scanRoot/<slug>` directories are exposed through a read-only compatibility
seam when there is no new pointer. Repository IDs are never used as path components;
the caller supplies the legacy slug separately. Retention can remove old immutable
artifact directories only after removing every publication/reference that needs them;
this foundation intentionally does not run deletion automatically.

Focused verification: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`,
then `node --test apps/server/dist/operatorStore.test.js` after compilation.
