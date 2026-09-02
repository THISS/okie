import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OLD_LINE_ALPHA = 0.1;
const tokens = readFileSync(new URL('../../../packages/theme/src/tokens.css', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('./renderer/Canvas2DRenderer.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

function rgbaAlpha(source: string, variable: string): number {
  const match = source.match(new RegExp(`${variable}:\\s*rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([0-9.]+)\\s*\\)`));
  if (!match) throw new Error(`Missing ${variable} rgba token`);
  return Number(match[1]);
}

describe('CLA-45: resting atlas line contrast stays above the old 0.1 hairline', () => {
  it('raises --atlas-line and --atlas-line-strong without restyling accent or inspector width', () => {
    const line = rgbaAlpha(tokens, '--atlas-line');
    const strong = rgbaAlpha(tokens, '--atlas-line-strong');

    expect(line).toBeGreaterThan(OLD_LINE_ALPHA);
    expect(strong).toBeGreaterThan(line);
    expect(tokens).toContain('--atlas-accent: #d9ff70;');
    expect(tokens).not.toMatch(/color-scheme:\s*light/);
    expect(css).toContain('--details-width: 376px');
  });

  it('keeps the canvas fallback region stroke and owner-shell stroke on the same floor', () => {
    const region = canvas.match(/rgba\(\s*176\s*,\s*207\s*,\s*194\s*,\s*([0-9.]+)\s*\)/);
    if (!region) throw new Error('Missing canvas region stroke');

    expect(Number(region[1])).toBeGreaterThan(OLD_LINE_ALPHA);
    expect(canvas).toContain('boundary ? C4_BOUNDARY_STROKE_ALPHA');
    expect(canvas).not.toContain('boundary ? .62');
  });
});
