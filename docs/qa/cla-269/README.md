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

# Increment 2 (search and sort): QA

Commit `5b78b63`, after `pnpm build`. Same local edge and local R2 as above. `/scan/index.json` carries a `description` and `language` for all 7 rows after the local `--backfill-meta`.

A `securitypolicyviolation` listener was installed before each page load. It recorded **0 violations on every page**: home (JS, 1440 and 390), `?q=`, `?sort=az`, the escaping probes, `/?fixture=okie` and `/r/pmndrs/zustand`. The no-JS context can't run a listener, and its console showed no CSP errors. The only console entry anywhere is the existing `Permissions-Policy: tools=(self)` origin-trial warning.

| Check | Result | Screenshot |
|---|---|---|
| `/` at 1440 | Pass. The search input (844×44), sort select and Search button sit on one row under "Published atlases (7)", with the count "7 atlases" below. All 7 cards show a description and language chips (TypeScript or Rust) next to the licence and entity count. No horizontal overflow. | `inc2-home-1440.png`, `inc2-home-1440-full.png` |
| Typing | Pass. Typing "zu" leaves only pmndrs/zustand, the count reads "1 of 7 atlases" and the URL becomes `/?q=zu`. Clearing the field shows all 7, "7 atlases" and `/`. Typing "qwxyzzy" shows "0 of 7" and the message "No atlases match “qwxyzzy”. Clear the search". The clear link goes to `/` with all 7 cards. Enter in the input filters without a reload. | `inc2-filter-zu-1440.png`, `inc2-nomatch-1440.png` |
| Sort | Pass. A–Z reorders the cards (ripgrep, excalidraw, docusaurus, zustand, atlas, axum, trpc) and the URL becomes `/?sort=az`. A reload keeps it, and so does a reload of `?q=ts&sort=az`. Switching back to "Most recent" drops `sort` from the URL. | `inc2-sort-az-1440.png` |
| Server-side widening | Pass. The raw HTML for `/?q=zu` has 6 `hidden` cards and "1 of 7 atlases". Deleting the query in the input shows all 7 and the URL returns to `/`. | — |
| No JS (`javaScriptEnabled: false`) | Pass. Submitting "rust" with A–Z goes to `/?q=rust&sort=az` and shows ripgrep and axum, in that order, with "2 of 7" and both controls pre-filled. `/?q=rip&sort=az` is filtered and in A–Z order (see issues for the match count). `/?q=zzqq` shows the no-match message. | `inc2-nojs-rip-az-1440.png`, `inc2-nojs-nomatch-1440.png` |
| 390×844 touch (`isMobile`, coarse pointer) | Pass. `scrollWidth` equals 390, and no element overflows. The input (358×44) is on its own row, with the select (271×44) and button (79×44) below. The input font is 16px, so iOS won't zoom. Tapping the input and typing "rust", then choosing A–Z, filters and sorts to `?q=rust&sort=az`. | `inc2-home-390.png`, `inc2-filter-390.png` |
| Escaping | Pass. `?q=<script>alert(1)</script>` and `?q="><img src=x onerror=alert(1)>` open no dialog, inject no element and trigger no CSP event. The server escapes the input `value` and the no-match echo (`&lt;…&gt;`, `&quot;`), and both show the text literally. | `inc2-escape-1440.png` |
| Keyboard | Pass. Tab order is CTA, mailto, input, select, Search button, then the first card. Each shows a 2 px teal `:focus-visible` outline. | `inc2-focus-select-1440.png`, `inc2-focus-button-1440.png` |
| Regressions | Pass. `/?fixture=okie` serves the SPA golden demo (canvas, no search form). `/r/pmndrs/zustand` renders a canvas. `/zzz` returns 404, `/new` returns 301 to `/`, and `/home.js` returns 200 `text/javascript` with `max-age=300` and `nosniff`. | `inc2-fixture-1440.png`, `inc2-zustand-1440.png` |

## Issues (increment 2)

- **Low: a substring match on the language field gives noisy results.** `rip` matches 6 of 7 atlases: ripgrep, plus every TypeScript card, because "Type**Script**" contains "rip". Likewise `ts` matches burntsushi/ripgrep through its stored name. The behaviour is correct as written, but it looks broken for short queries. Consider matching the language as a whole word or prefix, or matching at word starts.
- **Low: the ZWJ in emoji descriptions is stripped.** trpc's description is stored as `🧙♀️` (U+1F9D9 U+2640 U+FE0F, with no U+200D), so it renders as a mage followed by a separate ♀ sign. The zero-width stripping in the backfill or the index drops U+200D inside emoji sequences. A fix is to keep U+200D between emoji, or to strip only the bidi controls and U+200B/U+FEFF.
- **Note:** "Clear the search" links to `/`, so it also resets `sort=az` to Most recent. This is arguably intended.

### Increment 2: resolved before the PR

- **Search:** description and language match only at word starts, so `?q=rip` now shows ripgrep only.
- **Emoji:** zero-width joiners are kept, so ZWJ emoji such as 🧙‍♀️ render whole.

## Increment 3 (polish), on the local edge

| Check | Result | Screenshot |
|---|---|---|
| `/` at 1440 | Cards are the same height across each row, and their commit lines line up. Descriptions are clamped to 3 lines with the full text in `title`. The `excalidraw/excalidraw` and `facebook/docusaurus` thumbnails wrap onto two lines without clipping. All 7 images load. | `inc3-home-1440.png` |
| `/?q=ex` at 390 | 1 card shown, no horizontal overflow. `line-clamp` is 3. | `inc3-home-390.png` |
| `/og` edge cache | The second request is `CF-Cache-Status: HIT`. The browser still gets `cache-control: public, max-age=300`. | — |
| Console | 0 CSP violations. The only entry is the existing Permissions-Policy `tools` warning. | — |
