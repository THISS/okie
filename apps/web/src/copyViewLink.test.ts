import { describe, expect, it, vi } from 'vitest';
import { copyViewLink } from './copyViewLink';

describe('copyViewLink', () => {
  it('copies the exact canonical view URL supplied by navigation state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const url = 'https://atlas.example/r/acme/commerce/map/8f1c2ab?v=2&sel=e%3Aorders';
    await copyViewLink(url, { writeText });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it('fails explicitly when clipboard access is unavailable', async () => {
    await expect(copyViewLink('https://atlas.example/view', undefined)).rejects.toThrow('Clipboard access is unavailable.');
  });
});
