# 06 — Source Route (chosen direction)

A refinement of 05 Story Path that borrows the lime source cell from 01 Source Window.

- **Ring (top right):** the origin, the system context where a story starts.
- **Route:** a single guided path through the map. It draws an **S**, for Source.
- **Lime cell (bottom left):** the destination, one exact place in the source. It uses the theme's `--atlas-accent` (#d9ff70), the same lime as focus and selection in the app.

Changes from 05:
- Two stops instead of three stops plus a ring.
- One heavier 8/64 stroke.
- The route joins the origin ring, so it reads as a single path from a start point.

The favicon is drawn separately: a heavier stroke, a solid origin dot, and a dark tile, so it stays readable at 16 px.

Lockups set "Source For" in IBM Plex Sans 600 and "Atlas" in 400 muted. The text is live. Outline it in a vector editor for distribution masters.

Files: `mark-{light,dark}.svg`, `monochrome-{light,dark}.svg`, `source-for-{light,dark}.svg`, `source-for-atlas-{light,dark}.svg`, `favicon.svg`, and `preview.html`. The suffix names the background the file is designed for.
