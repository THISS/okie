---
name: okie-enrich
description: Enrich a portable Okie atlas from emitted scan prompts and matching source, then validate with the CLI without rescanning.
---

Follow the maintained [portable enrichment skill](../../../skills/okie-enrich/SKILL.md).

For older scan trios without a portable artifact, the legacy `okie-scan --source <repo> --revision <commit> --enrich-from <docs>` command remains available. It performs a deterministic rescan of the explicit committed revision. Prefer the portable `okie-scan enrich --bundle ... --docs ... --out ...` workflow when an artifact is available.
