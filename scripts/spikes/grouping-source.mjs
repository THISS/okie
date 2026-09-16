/** Conservative probe input: never present sanitized URL code as original source. */
export function prepareSource(source, redact) {
  const omittedLines = [];
  const lines = source.split('\n').map((line, index) => {
    // The gateway's broad URL scrub also normalizes template expressions. Omit
    // whole URL-bearing lines until source-aware redaction is implemented.
    if (/https?:\/\//i.test(line) || redact(line) !== line) {
      omittedLines.push(index + 1);
      return '// [source line omitted by payload sanitizer]';
    }
    return line;
  });
  return { source: lines.join('\n'), omittedLines };
}
