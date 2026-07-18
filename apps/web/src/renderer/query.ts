export type DemoQuery = {
  fixture: string;
  /** Selected scanned repository slug for `?fixture=scan:<slug>` (undefined = root self-scan). */
  scanRepo?: string;
  seed: number;
  backend: 'auto' | 'canvas2d' | 'webgpu' | 'webgl2';
  warnings: string[];
};

export function readDemoQuery(search: string): DemoQuery {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
  const requestedFixture = params.get('fixture') ?? 'okie';

  // A scanned repository is selected inline on the fixture param as `scan:<slug>`.
  // Riding the already-preserved `fixture` param (vs a new query key) keeps the slug in
  // the URL across reload/share without touching the pinned navigation URL machinery,
  // and avoids colliding with the reserved `repo` nav param (which encodes repositoryId).
  // Bare `scan` stays the Okie self-scan (root trio) for back-compat.
  let scanRepo: string | undefined;
  let normalizedFixture = requestedFixture;
  if (requestedFixture === 'scan' || requestedFixture.startsWith('scan:')) {
    normalizedFixture = 'scan';
    const rawSlug = requestedFixture.startsWith('scan:') ? requestedFixture.slice('scan:'.length).trim() : '';
    if (rawSlug) scanRepo = rawSlug;
  }

  const fixture = ['okie', 'stress', 'scan'].includes(normalizedFixture) ? normalizedFixture : 'okie';
  if (fixture !== normalizedFixture) warnings.push(`Unknown fixture “${requestedFixture}”; using Okie.`);

  const rawSeed = params.get('seed') ?? '42';
  const parsedSeed = Number.parseInt(rawSeed, 10);
  const seed = Number.isFinite(parsedSeed) ? Math.max(0, Math.min(parsedSeed, 2 ** 31 - 1)) : 42;
  if (!Number.isFinite(parsedSeed)) warnings.push(`Invalid seed “${rawSeed}”; using 42.`);

  const requestedBackend = params.get('backend') ?? 'auto';
  const backend = ['auto', 'canvas2d', 'webgpu', 'webgl2'].includes(requestedBackend)
    ? (requestedBackend as DemoQuery['backend'])
    : 'auto';
  if (backend !== requestedBackend) warnings.push(`Unknown backend “${requestedBackend}”; using auto.`);

  return { fixture, ...(scanRepo ? { scanRepo } : {}), seed, backend, warnings };
}
