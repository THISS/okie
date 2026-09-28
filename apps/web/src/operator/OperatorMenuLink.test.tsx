import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OperatorMenuLinkView, resolveOperatorMenuVisible, type OperatorSessionFetcher } from './OperatorMenuLink';

const respond = (ok: boolean, body: unknown): OperatorSessionFetcher => vi.fn(async () => ({ ok, json: async () => body }));

describe('account menu operator link', () => {
  it('is visible for a signed-in operator', async () => {
    const fetcher = respond(true, { operator: true });
    expect(await resolveOperatorMenuVisible(true, fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/operator/session', expect.objectContaining({ credentials: 'same-origin' }));
  });
  it('is hidden for a signed-in non-operator', async () => {
    expect(await resolveOperatorMenuVisible(true, respond(true, { operator: false }))).toBe(false);
    expect(await resolveOperatorMenuVisible(true, respond(true, {}))).toBe(false);
  });
  it('is hidden on a non-ok response or a network failure', async () => {
    expect(await resolveOperatorMenuVisible(true, respond(false, { operator: true }))).toBe(false);
    expect(await resolveOperatorMenuVisible(true, vi.fn(async () => { throw new TypeError('network down'); }))).toBe(false);
    expect(await resolveOperatorMenuVisible(true, respond(true, null))).toBe(false);
  });
  it('never requests the operator session when signed out', async () => {
    const fetcher = respond(true, { operator: true });
    expect(await resolveOperatorMenuVisible(false, fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('renders the /operator link only for operators', () => {
    const operator = renderToStaticMarkup(<OperatorMenuLinkView visible/>);
    expect(operator).toContain('href="/operator"');
    expect(operator).toContain('Operator workspace');
    expect(renderToStaticMarkup(<OperatorMenuLinkView visible={false}/>)).toBe('');
  });
});
