export type DisplayTextMode = 'word' | 'path' | 'identifier';
export type DisplayFontMetrics =
  | 'sans'
  | 'sans-regular'
  | 'sans-medium'
  | 'sans-semibold'
  | 'mono'
  | 'mono-regular'
  | 'mono-semibold';

// Normalized advances for ASCII 32–126 plus U+2026, frozen from the bundled
// IBM Plex Sans static faces at 48 px. The native atlas uses these exact TTF
// bytes and fontdue advance_width values; both IBM Plex Mono faces are 0.6 em.
const sansRegularAdvances = [
  .236, .284, .419, .713, .598, .927, .694, .242, .335, .335, .45, .6, .272, .399, .272, .383,
  .6, .6, .6, .6, .6, .6, .6, .6, .6, .6, .292, .292, .6, .6, .6, .477,
  .891, .641, .653, .621, .671, .583, .559, .695, .707, .4, .51, .634, .501, .812, .707, .708,
  .606, .708, .64, .581, .572, .678, .609, .891, .613, .593, .58, .317, .383, .317, .6, .565,
  .6, .534, .58, .503, .58, .549, .324, .528, .568, .25, .25, .527, .272, .873, .568, .56,
  .58, .58, .367, .487, .351, .568, .492, .768, .507, .499, .464, .343, .314, .343, .6, .803,
] as const;

const sansMediumAdvances = [
  .236, .298, .451, .678, .599, .947, .707, .253, .336, .336, .514, .6, .29, .401, .29, .417,
  .6, .6, .6, .6, .6, .6, .6, .6, .6, .6, .31, .31, .6, .6, .6, .487,
  .896, .662, .659, .634, .683, .593, .57, .705, .714, .416, .531, .66, .513, .814, .714, .712,
  .627, .712, .655, .598, .577, .686, .628, .926, .639, .617, .591, .325, .417, .325, .6, .561,
  .6, .549, .592, .51, .592, .556, .34, .537, .58, .265, .265, .547, .285, .882, .58, .564,
  .592, .592, .383, .494, .365, .58, .512, .799, .53, .514, .487, .354, .353, .356, .6, .846,
] as const;

const sansSemiboldAdvances = [
  .236, .309, .471, .656, .6, .96, .713, .26, .337, .337, .556, .6, .298, .402, .298, .437,
  .6, .6, .6, .6, .6, .6, .6, .6, .6, .6, .318, .318, .6, .6, .6, .493,
  .899, .672, .663, .642, .689, .6, .577, .712, .719, .423, .545, .678, .521, .816, .719, .712,
  .641, .712, .664, .611, .58, .69, .638, .949, .655, .632, .599, .329, .437, .329, .6, .559,
  .6, .559, .6, .513, .6, .558, .35, .545, .588, .276, .276, .562, .294, .888, .588, .563,
  .6, .6, .393, .499, .374, .588, .524, .819, .544, .524, .502, .363, .376, .363, .6, .868,
] as const;

function glyphAdvance(character: string, metrics: DisplayFontMetrics): number {
  if (metrics.startsWith('mono')) return 0.6;
  const advances = metrics === 'sans-medium'
    ? sansMediumAdvances
    : metrics === 'sans-semibold'
      ? sansSemiboldAdvances
      : sansRegularAdvances;
  if (character === '…') return advances[95]!;
  const code = character.codePointAt(0) ?? 63;
  const slot = code >= 32 && code <= 126 ? code - 32 : 63 - 32;
  return advances[slot]!;
}

export function displayMetricsForFontFamily(fontFamily: string): DisplayFontMetrics {
  const normalized = fontFamily.toLowerCase();
  if (normalized.includes('mono')) return normalized.includes('semibold') || normalized.includes('600')
    ? 'mono-semibold'
    : 'mono-regular';
  if (normalized.includes('semibold') || normalized.includes('600')) return 'sans-semibold';
  if (normalized.includes('medium') || normalized.includes('500')) return 'sans-medium';
  return 'sans-regular';
}

export function displayTextWidth(content: string, fontSize: number, metrics: DisplayFontMetrics = 'sans'): number {
  return characters(content).reduce((width, character) => width + glyphAdvance(character, metrics) * fontSize, 0);
}

function characters(value: string): string[] {
  return [...value];
}

function pathCandidate(root: string | undefined, tail: readonly string[]): string {
  return root ? `${root}/…/${tail.join('/')}` : `…/${tail.join('/')}`;
}

/**
 * Fits renderer copy without measuring fonts at runtime. The renderer's fixed
 * atlas and compiler use the same deterministic fitting algorithm. This
 * conservative character capacity is retained only for callers that do not
 * yet provide a metric role; final fitting always checks true advances.
 */
export function displayGlyphCapacity(maxWidth: number, fontSize: number): number {
  if (!Number.isFinite(maxWidth) || !Number.isFinite(fontSize) || maxWidth <= 0 || fontSize <= 0) return 0;
  return Math.max(0, Math.floor(maxWidth / (fontSize * 0.625)));
}

export function truncateDisplayText(content: string, capacity: number, mode: DisplayTextMode = 'word'): string {
  const maximum = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  if (characters(content).length <= maximum) return content;
  if (maximum === 0) return '';
  if (maximum === 1) return '…';

  if (mode === 'path' && content.includes('/') && !/\s/u.test(content)) {
    const segments = content.split('/').filter(Boolean);
    if (segments.length > 1) {
      const root = segments[0]!;
      for (let index = 1; index < segments.length; index += 1) {
        const rooted = pathCandidate(root, segments.slice(index));
        if (characters(rooted).length <= maximum) return rooted;
      }
      for (let index = 1; index < segments.length; index += 1) {
        const unrooted = pathCandidate(undefined, segments.slice(index));
        if (characters(unrooted).length <= maximum) return unrooted;
      }

      return `…${characters(segments.at(-1)!).slice(-(maximum - 1)).join('')}`;
    }
  }

  const prefix = characters(content).slice(0, maximum - 1).join('');
  if (mode === 'identifier') return `${prefix}…`;
  const boundary = prefix.search(/\s+\S*$/u);
  const completeWords = (boundary >= 0 ? prefix.slice(0, boundary) : '').trimEnd();
  return completeWords ? `${completeWords}…` : '…';
}

export function fitDisplayText(
  content: string,
  maxWidth: number,
  fontSize: number,
  mode: DisplayTextMode = 'word',
  metrics: DisplayFontMetrics = 'sans',
): string {
  if (displayTextWidth(content, fontSize, metrics) <= maxWidth) return content;
  for (let capacity = Math.max(1, characters(content).length - 1); capacity >= 1; capacity -= 1) {
    const candidate = truncateDisplayText(content, capacity, mode);
    if (displayTextWidth(candidate, fontSize, metrics) <= maxWidth) return candidate;
  }
  return maxWidth >= displayTextWidth('…', fontSize, metrics) ? '…' : '';
}
