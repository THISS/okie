# CLA-318 launch polish — QA

Screenshots in this folder are gitignored. They live alongside this file in the working tree where the QA was run.

## Production (sourcefor.dev), after increments 1–3

| Check | Result | Screenshot |
|---|---|---|
| `/new` at 1440 | Brand header, published list in GitHub casing (BurntSushi/ripgrep), footer with GitHub, contact and licence note | `cla318-prod-new-1440.png` |
| `/r/burnt-sushi/ripgrep` at 1440 | Header mark and "Source For Atlas". Title "ripgrep by BurntSushi · Source For Atlas". Attribution strip reads "ripgrep by BurntSushi · … · licence: Unlicense OR MIT · source on GitHub · About". 0 CSP violations. | `cla318-prod-ripgrep-1440.png` |
| `/r/burnt-sushi/ripgrep` on a 390 px phone (touch) | "Best on a larger screen" notice with "Continue anyway" and the footer | `cla318-prod-notice-390.png` |
| `/new` on a 390 px phone | List wraps with no horizontal overflow | `cla318-prod-new-390.png` |
| `/zzz` on a 390 px phone | Branded 404, HTTP 404 | `cla318-prod-404-390.png` |

`curl` smoke checks ran on staging and production after each deploy:

- **Favicon set and OG image:** `favicon.svg`, `favicon.ico` and the PNG icons, plus `og-default.png`.
- **Canonical and meta:** per-page `<title>`, meta description and OG tags. The canonical always points to `https://sourcefor.dev`, and staging canonicalizes to production.
- **Routes return 200:** 24 route shapes, including deep-nav queries, `?embed=1` and refs.
- **Branded 404:** `/zzz`, `/r/foo`, `/r/foo/bar`, `/operator/x` and `/new/extra`. HEAD requests also return 404.
- **301s:** case-variant links keep their query, and www redirects to the apex.
- **Headers:** CSP, `nosniff` and Referrer-Policy. `/r` sends no `frame-ancestors`, so embeds still work.
- **`/sitemap.xml`:** 9 URLs, and production `robots.txt` has a `Sitemap:` line.
- **Gzip packs:** decompress exactly once.

## Local edge (`wrangler dev`) during development

- **404 pages:** `cla318-zzz-404-{1440,390}.png` and `cla318-unknown-atlas-404-{1440,390}.png`.
- **Mobile notice:** `cla318-mobile-notice-390.png`, and after "Continue anyway", `cla318-mobile-continued-390.png`.
- **CSP runs:** `cla318-csp-*.png` and `csp-export.png` cover the inspector source, full source, PNG export and a cross-origin `?embed=1` iframe. A `securitypolicyviolation` listener recorded 0 violations. Both WebGPU and forced WebGL2 were checked.
- **Analytics (increment 4):** with a fake token, each HTML page carries exactly one beacon and there are no CSP violations. Without a token there is no beacon and no analytics origins in the CSP.

## Known follow-ups

- **Mobile notice casing:** the notice's heading uses the URL casing ("ripgrep by burnt-sushi"), because it renders before the published index is read. The server title and the attribution strip already use GitHub casing.
- **Golden dogfood fixture:** it still says "Okie" (canvas title and L1 node) on `/`. That fixture is part of the determinism contract, so it stays until CLA-315.
- **Analytics:** switched off until the production `WEB_ANALYTICS_TOKEN` is set.
