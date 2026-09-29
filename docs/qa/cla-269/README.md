# CLA-269 increment 1 (edge-rendered home): QA

Screenshots in this folder are gitignored. They live alongside this file in the working tree where the QA was run.

Run against the local edge (`wrangler dev`, 127.0.0.1:4196) with local R2 seeded from staging:

- `atlas/v1/index.json` (7 atlases);
- `latest.json` and the version manifest for all 7 slugs;
- every public file and pack for `source-for__atlas` and `pmndrs__zustand` (41 objects).

A `securitypolicyviolation` listener was installed before each page load. It recorded **0 violations on every page**.

| Check | Result | Screenshot |
|---|---|---|
| `/` at 1440 | Pass. The hero shows "Explore an atlas" (links to `/r/source-for/atlas`) and a mailto link. There are 7 cards in a 3-column grid, in GitHub casing (BurntSushi/ripgrep). All 7 `/og` thumbnails load. Each card shows its licence (including `Unlicense OR MIT` and `MIT AND CC-BY-4.0`), entity count (`2,831 entities`) and `commit <sha7> · <date>`. The footer is `#about`. No horizontal overflow. | `inc1-home-1440.png`, `inc1-home-1440-full.png` |
| `/` at 390 (touch, `isMobile`, coarse pointer) | Pass. Single column with cards 358 px wide. `scrollWidth` equals `innerWidth` (390). The CTA is 157×47 and each card is 358×300. Tapping the CTA opens the atlas's "Best on a larger screen" notice. | `inc1-home-390.png`, `inc1-home-390-full.png`, `inc1-cta-tap-390.png` |
| CTA and card at 1440 | Pass. Both `/r/source-for/atlas` and `/r/pmndrs/zustand` render a canvas (1037×768). The attribution strip's About link is `/#about`: it lands on the home with `:target` set to `#about` and the footer in view. | `inc1-atlas-cta-1440.png`, `inc1-atlas-card-zustand-1440.png`, `inc1-about-anchor-1440.png` |
| Golden demo | Pass. `/?fixture=okie` and `/?fixture=okie&q=x` both serve the SPA golden demo with a canvas. | `inc1-fixture-1440.png`, `inc1-fixture-q-1440.png` |
| Cross-origin `?embed=1` | Pass. A host page on `http://127.0.0.1:4199` iframes `/r/source-for/atlas?embed=1`, which renders a 1200×640 canvas. The home in an iframe is blocked by `frame-ancestors 'self'`, the same as the SPA `/` today. | `inc1-embed-crossorigin.png` |
| 404s | Pass. `/zzz`, `/r/foo/bar` and `/new/extra` each return a branded 404 with HTTP 404. "Browse published atlases" links to `/` and lands on the home. | `inc1-404-*-1440.png` |
| Keyboard | Pass. Tab order is CTA, mailto, the 7 cards, then the footer links. Cards show a 2 px teal outline. The CTA gets only the browser's default ring (see issues). | `inc1-focus-cta-1440.png`, `inc1-focus-card-1440.png` |

`curl` checks (local edge):

- **Home:** `/`, `/index.html`, `/?q=x&sort=az` and `/?utm_source=x&ref=y&fbclid=1&gclid=2` serve it (200, `public, max-age=60`).
- **SPA:** `/?fixture=okie`, `/?fixture=okie&q=x` and `/?a=1` serve the SPA shell.
- **HEAD and POST:** `HEAD /` returns 200 with no body. `POST /` returns 405.
- **Redirects:** `/new` and `/new/` 301 to `/`, and `/new?a=1` 301s to `/?a=1`, all with `max-age=3600`. `HEAD /new` returns 301.
- **Headers on `/`:** CSP (including `frame-ancestors 'self'`), `nosniff` and Referrer-Policy.
- **`/sitemap.xml`:** 8 URLs (`/` plus 7 atlases), with no `/new`.
- **Other routes:** `/og/source-for/atlas` returns 200 `image/png`. `/r/source-for/atlas?embed=1` returns 200 with no `frame-ancestors`.

## Issues

- **Low: card order doesn't match the date shown.** Cards are sorted by `publishedAt` (newest first), but each card shows the commit date (`generatedAt`). So BurntSushi/ripgrep, dated "4 Aug 2026", comes first, ahead of cards dated "29 Sep 2026", and the grid looks unsorted. Either sort by the date shown, or label it (for example, "published …").
- **Low: CTA focus ring.** `.cta` has no `:focus-visible` style, so it gets Chrome's default 1 px `auto` ring (pale blue). It is visible but much weaker than the cards' 2 px teal outline.
- **Low: `/new?<other>` lands on the golden demo.** The 301 keeps the query, so `/new?a=1` goes to `/?a=1`, and `a` is not on the home allowlist, so the SPA golden demo loads. This only affects old `/new` links that carry a query outside the allowlist. Allowlisted params such as `utm_*` still reach the home.
- **Note, not a defect:** the thumbnail text for `excalidraw/excalidraw` is clipped inside the `/og` image itself. The OG renderer predates this change.

### Resolved before the PR

- **Order:** cards now sort by the commit date shown (newest first).
- **Focus:** the CTA and the mailto link have a 2 px teal `:focus-visible` outline.
- **`/new` redirect:** it keeps only the home allowlist, so `/new?a=1` goes to `/`.
- **Review follow-ups:**
  - `/` sends `Permissions-Policy` and `Origin-Agent-Cluster` again.
  - The CTA falls back to the first card when source-for/atlas isn't published.
  - The first 3 thumbnails load eagerly.
  - Bidi and zero-width characters are stripped from card text.
