export type DemoQuery = {
  fixture: string;
  seed: number;
  backend: 'auto' | 'canvas2d' | 'webgpu' | 'webgl2';
  warnings: string[];
};

export function readDemoQuery(search: string): DemoQuery {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
  const requestedFixture = params.get('fixture') ?? 'okie';
  const fixture = ['okie', 'stress', 'scan'].includes(requestedFixture) ? requestedFixture : 'okie';
  if (fixture !== requestedFixture) warnings.push(`Unknown fixture “${requestedFixture}”; using Okie.`);

  const rawSeed = params.get('seed') ?? '42';
  const parsedSeed = Number.parseInt(rawSeed, 10);
  const seed = Number.isFinite(parsedSeed) ? Math.max(0, Math.min(parsedSeed, 2 ** 31 - 1)) : 42;
  if (!Number.isFinite(parsedSeed)) warnings.push(`Invalid seed “${rawSeed}”; using 42.`);

  const requestedBackend = params.get('backend') ?? 'auto';
  const backend = ['auto', 'canvas2d', 'webgpu', 'webgl2'].includes(requestedBackend)
    ? (requestedBackend as DemoQuery['backend'])
    : 'auto';
  if (backend !== requestedBackend) warnings.push(`Unknown backend “${requestedBackend}”; using auto.`);

  return { fixture, seed, backend, warnings };
}
