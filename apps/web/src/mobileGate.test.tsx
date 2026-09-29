import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MOBILE_NOTICE_SESSION_KEY,
  MobileNotice,
  mobileNoticeCopy,
  mobileNoticeDismissed,
  readMobileGateInput,
  rememberMobileNoticeDismissed,
  shouldShowMobileNotice,
  type MobileGateInput,
} from './mobileGate';
import { parseAppRoute } from './renderer/route';
import { CONTACT_EMAIL, GITHUB_REPO_URL, HOME_DESCRIPTION, repoPageDescription } from './siteMeta';

const desktop: MobileGateInput = { width: 1440, height: 900, coarsePointer: false, noHover: false, framed: false, embedQuery: false, dismissed: false };
const touch = { coarsePointer: true, noHover: true };

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('CLA-318 small-screen notice', () => {
  it('shows only on touch-primary devices: below 720px wide, or a phone held landscape', () => {
    expect(shouldShowMobileNotice(desktop)).toBe(false);
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 390, height: 844 })).toBe(true);
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 719 })).toBe(true);
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 720 })).toBe(false);
    // Either signal counts as touch-primary.
    expect(shouldShowMobileNotice({ ...desktop, coarsePointer: true, width: 390 })).toBe(true);
    expect(shouldShowMobileNotice({ ...desktop, noHover: true, width: 390 })).toBe(true);
    // iPhone landscape: wide but short.
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 844, height: 390 })).toBe(true);
    // Tablets are fine.
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 1024, height: 768 })).toBe(false);
  });

  it('never shows in a desktop window, however narrow or short (mouse + hover)', () => {
    for (const [width, height] of [[390, 844], [719, 900], [844, 390], [320, 320]]) {
      expect(shouldShowMobileNotice({ ...desktop, width, height }), `${width}x${height}`).toBe(false);
    }
  });

  it('never shows in embeds or after "Continue anyway"', () => {
    const phone = { ...desktop, ...touch, width: 390, height: 844 };
    expect(shouldShowMobileNotice({ ...phone, framed: true })).toBe(false);
    expect(shouldShowMobileNotice({ ...phone, embedQuery: true })).toBe(false);
    expect(shouldShowMobileNotice({ ...phone, dismissed: true })).toBe(false);
  });

  it('remembers "Continue anyway" per session and survives blocked storage', () => {
    const win = { sessionStorage: memoryStorage() };
    expect(mobileNoticeDismissed(win)).toBe(false);
    rememberMobileNoticeDismissed(win);
    expect(win.sessionStorage.getItem(MOBILE_NOTICE_SESSION_KEY)).toBe('1');
    expect(mobileNoticeDismissed(win)).toBe(true);
    const blocked = { get sessionStorage(): Storage { throw new Error('SecurityError'); } };
    expect(mobileNoticeDismissed(blocked)).toBe(false);
    expect(() => rememberMobileNoticeDismissed(blocked)).not.toThrow();
    const throwing = { sessionStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } };
    expect(mobileNoticeDismissed(throwing)).toBe(false);
    expect(() => rememberMobileNoticeDismissed(throwing)).not.toThrow();
  });

  it('reads the viewport, pointer, frame and ?embed=1 from the window', () => {
    const win = { innerWidth: 390, innerHeight: 844, location: { search: '?embed=1' }, matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }), sessionStorage: memoryStorage() };
    const top = {};
    expect(readMobileGateInput({ ...win, self: top, top })).toEqual({ width: 390, height: 844, coarsePointer: true, noHover: true, framed: false, embedQuery: true, dismissed: false });
    expect(readMobileGateInput({ ...win, location: { search: '' }, self: {}, top: {}, matchMedia: undefined }).framed).toBe(true);
    expect(readMobileGateInput({ ...win, location: { search: '' }, self: top, top, matchMedia: undefined })).toMatchObject({ coarsePointer: false, noHover: false });
  });

  it('leads with the atlas identity and its description (what a phone-width crawler reads)', () => {
    const copy = mobileNoticeCopy(parseAppRoute('/r/BurntSushi/ripgrep'));
    expect(copy).toEqual({ heading: 'ripgrep by BurntSushi', description: repoPageDescription('BurntSushi', 'ripgrep') });
    expect(mobileNoticeCopy(parseAppRoute('/')).description).toBe(HOME_DESCRIPTION);
    const html = renderToStaticMarkup(<MobileNotice {...copy} onContinue={() => {}} />);
    expect(html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1]).toBe('ripgrep by BurntSushi');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(copy.description);
    expect(html).toContain('Best on a larger screen</h2>');
    expect(html).toContain('Continue anyway');
    expect(html).toContain('<a href="/" ');
    expect(html).not.toContain('href="/new"');
    expect(html).toContain(`href="${GITHUB_REPO_URL}"`);
    expect(html).toContain(CONTACT_EMAIL);
  });
});
