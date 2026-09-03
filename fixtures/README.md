# Deterministic renderer fixtures

`architecture/` contains the canonical semantic snapshot, view, and story. `renderer/` contains the exact protocol documents compiled from those inputs. The scene compiler test fails if a checked renderer fixture drifts from its semantic source.

Regenerate the small checked fixtures with:

```sh
pnpm generate:fixtures
```

Generate the large, ignored benchmark scene with:

```sh
pnpm generate:stress -- --nodes 5000 --edges 15000 --seed 42
```

The generator uses a seeded PRNG and stable identifiers, so identical arguments produce byte-identical output. Large stress documents are intentionally not committed.

`architecture/band-cost-curve.json` is the CLA-67 per-band compile/payload table (structural metrics are golden; observed milliseconds are host samples). Regenerate with `node scripts/measure-band-cost.mjs` after building `@okie/scene-compiler`. The 2000 hang-guard is not this file.
