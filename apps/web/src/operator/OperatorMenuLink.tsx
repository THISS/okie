import { useEffect, useState } from 'react';

/** Minimal fetch shape so tests inject a fake without a DOM. */
export type OperatorSessionFetcher = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;
const defaultFetcher: OperatorSessionFetcher = (input, init) => fetch(input, init);

/** Visible only for a signed-in operator; signed-out users never trigger the session request. Any failure hides the link. */
export async function resolveOperatorMenuVisible(signedIn: boolean, fetcher: OperatorSessionFetcher = defaultFetcher): Promise<boolean> {
  if (!signedIn) return false;
  try {
    const response = await fetcher('/api/operator/session', { credentials: 'same-origin' });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return !!body && typeof body === 'object' && (body as { operator?: unknown }).operator === true;
  } catch { return false; }
}

export function OperatorMenuLinkView({ visible }: { visible: boolean }) {
  return visible ? <a data-testid="account-operator" href="/operator">Operator workspace</a> : null;
}

/** Account-menu entry to /operator; refetches when sign-in state changes and ignores responses after unmount. */
export function OperatorMenuLink({ signedIn, fetcher = defaultFetcher }: { signedIn: boolean; fetcher?: OperatorSessionFetcher }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let live = true;
    setVisible(false);
    void resolveOperatorMenuVisible(signedIn, fetcher).then(value => { if (live) setVisible(value); });
    return () => { live = false; };
  }, [signedIn, fetcher]);
  return <OperatorMenuLinkView visible={visible}/>;
}
