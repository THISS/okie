# Persistence browser acceptance

## Status: passed — automated package checks and user manual import acceptance

Actual UI exploration used the rebuilt static site at `http://127.0.0.1:50927/portable-atlas/` in a dedicated Chrome tab (794341313).

- **Passed:** Clicked **Forget** in the portable footer. The atlas was replaced by **Open a local atlas**, local-only explanatory copy, and **Choose local atlas…**. The coordinator later observed the tab URL ending in `?portable=1&open=1`.
- **Blocked:** Started the supported `filechooser` event before clicking **Choose local atlas…**. The chooser was obtained, then `chooser.setFiles(['/tmp/okie-cli-final-smoke/atlas.okie.json'])` stalled inside the browser tool and ultimately returned `Not allowed` / `fileChooser.setFiles failed`. This was one attempt, with no repeated retries. The pending tool call prevented progress updates until it returned.
- **Not verified by this agent:** successful native import, reload after import, Replace with another repository then reload, and Forget→Open→reload. The user volunteered to complete these checks manually with the coordinator.

One native-app fallback was attempted after the chooser failure: inventoried and selected the dedicated QA tab, clicked its file-selection text, and requested the Chrome native surface. It returned an unrelated Chrome profile/window with GitHub open, with no file dialog. No path keystrokes were sent into that unrelated window. Further chooser attempts stopped when the user took over manual import acceptance.

## Manual acceptance

After receiving the four-step test instructions, the user confirmed: “manual results looked good, nice stuff”. This closes the requested small-scan import/reload, Replace with Okie/reload, and Forget→reopen small scan→reload acceptance. These results are user-reported, not automated file-picker evidence. The automation restriction below is retained as history.

## Packaged-path and redeploy checks

Created QA-only exports with `node packages/scan/dist/cli.js export`, the final `apps/web/dist-portable`, and real artifacts. Served `/tmp/okie-portable-static` on loopback `http://127.0.0.1:50928` (Python static server, no application backend). The original `/portable-atlas/` export was not modified.

- **Passed A:** `/qa-persistence-a/` loads `portable-cli-smoke`, revision `272a0322a954`, 5 entities, from `/tmp/okie-cli-final-smoke/atlas.okie.json`.
- **Passed B:** `/qa-persistence-b/` on the same origin loads Okie, revision `722ea2862304`, 3121 entities, from `/tmp/okie-portable-final-scan/atlas.okie.json`.
- **Passed return/reload:** navigating back to A preserves A's repository; reloading A still shows `272a0322a954`. Reloading B still shows `okie scan` and `722ea2862304`.
- **Passed changed package at same path:** renamed the QA A export to a backup and exported the Okie artifact at `/qa-persistence-a/`. Reloading the existing A URL now shows `okie scan` and `722ea2862304`, rather than the old smoke package. B still loads/reloads its own Okie package afterward.

These are default packaged-atlas checks. They do not establish persistence of a user-selected replacement bundle, which remains part of manual native-import acceptance. On the changed-package reload, the old camera URL initially left nodes offscreen while the new inspector/minimap identity was correct; no camera reset acceptance is claimed here.

Evidence: [A after reload](persistence-a-reloaded.png), [A after changed-package reload](persistence-a-redeployed.png).

No product files changed. No pass is claimed from unit tests or storage implementation for these unfinished browser checks. Static map/source/story acceptance and the footer fix are separately documented in `final-static-browser-qa.md`.
