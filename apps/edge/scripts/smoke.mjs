#!/usr/bin/env node
// Post-deploy smoke checks for the edge Worker (CLA-318): the scripted part of the runbook's §3 list.
//
//   pnpm --filter @okie/edge smoke:staging
//   pnpm --filter @okie/edge smoke:production
//
// staging.sourcefor.dev is behind Cloudflare Access. The checks send the `atlas-staging-smoke` service
// token as CF-Access-Client-Id / CF-Access-Client-Secret when STAGING_ACCESS_CLIENT_ID and
// STAGING_ACCESS_CLIENT_SECRET are set (in the environment, or the repo-root .env, which is gitignored).
// Without them, staging's Access login fails the run with a message naming the keys. Production is public
// and never gets the headers. No value is ever printed. Browser checks (CSP console, beacon load) stay manual.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AccessChallengeError, accessHeaders, redactHeaderValues, smokeRequester } from './smokeAccess.mjs';

const ORIGINS = { staging: 'https://staging.sourcefor.dev', production: 'https://sourcefor.dev' };
const BEACON = /cloudflareinsights\.com\/beacon/g;

const target = process.argv[2];
if (!Object.hasOwn(ORIGINS, target ?? '')) {
  console.error(`usage: smoke.mjs <${Object.keys(ORIGINS).join('|')}>`);
  process.exit(2);
}
const origin = ORIGINS[target];

const dotenv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv); // never overrides variables already set

const access = accessHeaders(target, process.env);
if (access.error) {
  console.error(`smoke: ${access.error}`);
  process.exit(1);
}
const sentToken = Object.keys(access.headers).length > 0;
if (target === 'staging') console.log(sentToken ? 'using the Access service token (STAGING_ACCESS_CLIENT_ID)' : 'no Access service token set');

const get = smokeRequester({ origin, headers: access.headers });
const describe = error => redactHeaderValues(error instanceof Error ? error.message : String(error), access.headers);

const failures = [];
async function check(name, run) {
  try {
    const problem = await run();
    if (problem) {
      failures.push(name);
      console.log(`FAIL ${name}: ${problem}`);
    } else {
      console.log(`ok   ${name}`);
    }
  } catch (error) {
    if (error instanceof AccessChallengeError) throw error;
    failures.push(name);
    console.log(`FAIL ${name}: ${describe(error)}`);
  }
}

const expectedBeacons = target === 'production' ? 1 : 0;
function htmlProblems(response, body, status = 200) {
  if (response.status !== status) return `status ${response.status}, want ${status}`;
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return `content-type ${response.headers.get('content-type')}`;
  if (!response.headers.get('content-security-policy')) return 'no Content-Security-Policy';
  if (response.headers.get('x-content-type-options') !== 'nosniff') return 'no X-Content-Type-Options: nosniff';
  const beacons = body.match(BEACON)?.length ?? 0;
  if (beacons !== expectedBeacons) return `${beacons} analytics beacons, want ${expectedBeacons}`;
  return undefined;
}

async function main() {
  console.log(`smoke checks against ${origin}`);
  // The first request doubles as the Access probe: a login redirect stops the run here.
  await check('/ (home)', async () => {
    const response = await get('/');
    const body = await response.text();
    return htmlProblems(response, body) ?? (body.includes('data-home') ? undefined : 'no data-home marker');
  });
  await check('/?fixture=okie (SPA shell)', async () => {
    const response = await get('/?fixture=okie');
    return htmlProblems(response, await response.text());
  });
  await check('/zzz (branded 404)', async () => {
    const response = await get('/zzz');
    return htmlProblems(response, await response.text(), 404);
  });
  await check('/new (301 to /)', async () => {
    const response = await get('/new', 'HEAD');
    return response.status === 301 && response.headers.get('location') === '/' ? undefined : `status ${response.status}, location ${response.headers.get('location')}`;
  });
  await check('/robots.txt', async () => {
    const response = await get('/robots.txt');
    const body = await response.text();
    if (response.status !== 200) return `status ${response.status}`;
    if (target === 'staging') return /Disallow:\s*\/\s*$/m.test(body) && response.headers.get('x-robots-tag') === 'noindex, nofollow' ? undefined : 'not disallow-all with X-Robots-Tag noindex';
    return body.includes('Sitemap: https://sourcefor.dev/sitemap.xml') ? undefined : 'no Sitemap line';
  });
  await check('/sitemap.xml', async () => {
    const response = await get('/sitemap.xml');
    return response.status === 200 && (response.headers.get('content-type') ?? '').includes('application/xml') ? undefined : `status ${response.status}, content-type ${response.headers.get('content-type')}`;
  });
  await check('/api/auth/me (browse-only)', async () => {
    const response = await get('/api/auth/me');
    const body = await response.json();
    return response.status === 200 && body.ask === false ? undefined : `status ${response.status}, ask ${body.ask}`;
  });
  await check('/assets/missing.js (404)', async () => {
    const response = await get('/assets/missing.js', 'HEAD');
    return response.status === 404 ? undefined : `status ${response.status}`;
  });

  let slug;
  await check('/scan/index.json', async () => {
    const response = await get('/scan/index.json');
    if (response.status !== 200) return `status ${response.status}`;
    const index = await response.json();
    slug = index.repos?.find(row => typeof row.slug === 'string' && row.slug.includes('__'))?.slug;
    return slug ? undefined : 'no published atlas';
  });
  if (slug) {
    const path = slug.replace('__', '/');
    await check(`/r/${path} (share page)`, async () => {
      const response = await get(`/r/${path}`);
      const body = await response.text();
      const problem = htmlProblems(response, body);
      if (problem) return problem;
      if (/frame-ancestors/.test(response.headers.get('content-security-policy') ?? '')) return 'CSP has frame-ancestors (embeds would break)';
      return body.includes('property="og:image"') ? undefined : 'no og:image';
    });
    await check(`/og/${path} (card PNG)`, async () => {
      const response = await get(`/og/${path}`);
      await response.arrayBuffer();
      return response.status === 200 && response.headers.get('content-type') === 'image/png' ? undefined : `status ${response.status}, content-type ${response.headers.get('content-type')}`;
    });
  }

  if (failures.length > 0) {
    console.error(`${failures.length} smoke check(s) failed against ${origin}`);
    process.exit(1);
  }
  console.log(`all smoke checks passed against ${origin}`);
}

main().catch(error => {
  console.error(`smoke: ${describe(error)}`);
  process.exit(1);
});
