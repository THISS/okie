import { PORTABLE_ATLAS_MAX_BYTES, parsePortableAtlas, type PortableAtlas } from '@okie/architecture';
import type { PortablePersistence } from './storage';

/** Check metadata before allocating the uploaded file's contents. */
export async function readPortableFile(file: Pick<File, 'size' | 'text'>): Promise<{ bundle?: PortableAtlas; error?: string }> {
  if (file.size > PORTABLE_ATLAS_MAX_BYTES) return { error: 'Scan bundle exceeds the 128 MiB import limit.' };
  try { return { bundle: parsePortableAtlas(await file.text()) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

/** Persistence is convenience storage; its failure must never prevent local use. */
export async function rememberPortableSession(persistence: PortablePersistence, bundle: PortableAtlas): Promise<string | undefined> {
  const result = await persistence.remember(bundle);
  return result.saved ? undefined : `Opened for this session. Browser storage could not save this atlas; a previous saved atlas may reappear after reload. ${result.error ?? ''}`.trim();
}

export async function forgetPortableSession(persistence: PortablePersistence): Promise<string | undefined> {
  const result = await persistence.forget();
  return result.cleared ? undefined : `Atlas closed for this session. Its saved browser copy could not be cleared and may still be present. ${result.error ?? ''}`.trim();
}
