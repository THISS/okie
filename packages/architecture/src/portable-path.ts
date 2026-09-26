/** Repository-relative POSIX path: no absolute, drive, URL, control, `.`/`..` or empty segments. */
export function portableSourcePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !/[\\\u0000-\u001f:]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
