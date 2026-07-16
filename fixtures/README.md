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
