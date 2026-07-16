# @okie/theme

CSS design tokens for the Okie web app — the single source of colour, spacing,
and typography custom properties. No JavaScript, no build step.

- **Entry:** exports only `./tokens.css` (`package.json` `exports` map →
  `src/tokens.css`). Consumers import `@okie/theme/tokens.css`.
- **Test:** none (static CSS); exercised indirectly by `apps/web` rendering.
- **Pins:** none — not part of the golden fixture.
