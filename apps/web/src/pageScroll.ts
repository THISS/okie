/**
 * The atlas owns the viewport (`body { overflow: hidden }` in app.css). Document-style
 * pages (operator workspace, `/new` landing, portable picker, load errors) opt into a
 * single natural page scroll by marking <body>; every mount sets it explicitly so
 * switching between the operator workspace and its atlas draft preview toggles it.
 */
export const DOCUMENT_PAGE_CLASS = 'document-page';
export function setDocumentPage(enabled: boolean, body: Pick<HTMLElement, 'classList'> = document.body): void {
  body.classList.toggle(DOCUMENT_PAGE_CLASS, enabled);
}

/** What main.tsx is mounting. Document pages scroll the viewport; atlas mounts keep it fixed. */
export type PageKind = 'operator' | 'landing' | 'picker' | 'error' | 'atlas' | 'portable' | 'preview';
export function documentPageFor(kind: PageKind): boolean {
  switch (kind) { case 'operator': case 'landing': case 'picker': case 'error': return true; case 'atlas': case 'portable': case 'preview': return false; }
}
