/**
 * The portable viewer (build-portable-viewer.mjs) ships the hosted index.html, whose head carries
 * sourcefor.dev's canonical link and Open Graph / Twitter card tags (CLA-318). A self-hosted copy is
 * not a sourcefor.dev page, so those are stripped and the portable marker is added.
 *
 * @param {string} html
 * @returns {string}
 */
export function portableIndexHtml(html) {
  return html
    .replace(/[ \t]*<link\s+rel=["']canonical["'][^>]*>\r?\n?/gi, '')
    .replace(/[ \t]*<meta\s+(?:property|name)=["'](?:og|twitter):[^"']*["'][^>]*>\r?\n?/gi, '')
    .replace('</head>', '<meta name="okie-portable" content="true">\n</head>');
}
