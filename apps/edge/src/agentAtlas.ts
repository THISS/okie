import { JSONParser, TokenType } from '@streamparser/json';
import { agentRepositoryPath, agentPublicText, agentEntity, agentEvidence, agentRelations, agentSearch, type ArchitectureSnapshot } from '@okie/architecture';
import { isPublishedSlug, isPublishedVersionId, PUBLISHED_LATEST_SCHEMA, PUBLISHED_INDEX_SCHEMA, PUBLISHED_VERSION_SCHEMA, publishedIndexKey, publishedLatestKey, publishedManifestKey, publishedPublicFileKey } from '../../server/src/publishedStoreLayout';
import { handleScanRoute } from './scan';
import { agentPublicationFreshness, publicationTimestamp } from './agentFreshness';
import { canonicalAtlasPathForSlug } from '../../web/src/publishedNames';

export class AgentAtlasError extends Error {
  constructor(readonly code: 'invalid_arguments' | 'not_found' | 'unavailable', message: string) { super(message); this.name = 'AgentAtlasError'; }
}
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export { AGENT_TOOL_DESCRIPTORS } from '../../web/src/agentToolCatalog';
import { AGENT_TOOL_DESCRIPTORS } from '../../web/src/agentToolCatalog';

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function invalid(): never { throw new AgentAtlasError('invalid_arguments', 'Invalid atlas query arguments.'); }
function missing(): never { throw new AgentAtlasError('not_found', 'Published atlas or version was not found.'); }
async function boundedJson(stream: ReadableStream<Uint8Array>, maximum: number): Promise<unknown> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maximum) { void reader.cancel().catch(() => undefined); throw new Error('limit'); } chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new AgentAtlasError('unavailable', 'Published atlas data is unavailable.'); }
}
async function objectJson(bucket: R2Bucket, key: string, maximum: number): Promise<unknown> {
  const object = await bucket.get(key);
  if (!object) return undefined;
  if (object.size > maximum) { void object.body.cancel().catch(() => undefined); throw new AgentAtlasError('unavailable', 'Published atlas data is unavailable.'); }
  return boundedJson(object.body, maximum);
}
async function publicSnapshot(bucket: R2Bucket, key: string): Promise<Record<string, unknown>> {
  const maximum = 64 * 1024 * 1024;
  const object = await bucket.get(key);
  if (!object) return {};
  if (object.size > maximum) { void object.body.cancel().catch(() => undefined); throw new Error('snapshot limit'); }
  const parser = new JSONParser({ keepStack:false, emitPartialTokens:true, paths:['$.entities.*','$.relations.*','$.entities.*.sourceExcerpts.*','$.entities.*.sourceExcerpts','$.schemaVersion','$.id','$.repositoryId','$.commitSha','$.generatedAt','$.entities','$.relations'] });
  const result: Record<string,unknown> = {entities:[],relations:[]};
  const entities = result.entities as Record<string,unknown>[];
  const relations = result.relations as Record<string,unknown>[];
  let graphBytes = 0, rawBytes = 0, pendingBytes = 0, tokens = 0, depth = 0;
  let entitiesSeen = false, relationsSeen = false;
  const identifier = (value:unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
  const text = (value:unknown,maximum:number) => typeof value === 'string' ? agentPublicText(value,maximum) : '';
  const reference = (value:unknown) => {
    const ref=record(value);
    // Preserve path identity until the shared selector validates it; rewriting a host path
    // into a redaction label would falsely make it look like repository-relative evidence.
    return {path:identifier(ref.path),commitSha:text(ref.commitSha,128),...(typeof ref.symbol==='string'?{symbol:text(ref.symbol,256)}:{}),...(Number.isSafeInteger(ref.startLine)?{startLine:ref.startLine}:{}),...(Number.isSafeInteger(ref.endLine)?{endLine:ref.endLine}:{})};
  };
  parser.onToken = ({token,value}) => {
    if (++tokens > 20000 || typeof value === 'string' && value.length > 128*1024) throw new Error('token limit');
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) { if (++depth > 64) throw new Error('depth limit'); }
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth--;
  };
  parser.onValue = ({key,value,stack}) => {
    pendingBytes=0;tokens=0;
    if (stack.length===1 && key==='entities') { if(!Array.isArray(value)) throw new Error('entities'); entitiesSeen=true;return; }
    if (stack.length===1 && key==='relations') { if(!Array.isArray(value)) throw new Error('relations'); relationsSeen=true;return; }
    if (stack.length===1 && typeof key==='string') { result[key]= key==='id' ? identifier(value) : typeof value==='string'?text(value,512):value;return; }
    if(stack.length!==2) return;
    const section=stack[1]?.key;
    const source=record(value);
    let projected:Record<string,unknown>;
    if(section==='entities') {
      projected={id:identifier(source.id),kind:text(source.kind,64),name:text(source.name,256),sourceRefs:Array.isArray(source.sourceRefs)?source.sourceRefs.slice(0,17).map(reference):[]};
      if(typeof source.parentId==='string') projected.parentId=identifier(source.parentId);
      if(typeof source.responsibility==='string') projected.responsibility=text(source.responsibility,1600);
      if(Array.isArray(source.technology)) projected.technology=source.technology.slice(0,8).map(value=>text(value,128));
      if(entities.length>=100000) throw new Error('count');entities.push(projected);
    } else if(section==='relations') {
      projected={id:identifier(source.id),from:identifier(source.from),to:identifier(source.to),kind:text(source.kind,64),evidence:Array.isArray(source.evidence)?source.evidence.slice(0,16).map(value=>({source:reference(record(value).source)})):[]};
      if(typeof source.label==='string') projected.label=text(source.label,512);
      if(relations.length>=100000) throw new Error('count');relations.push(projected);
    } else return;
    graphBytes+=new TextEncoder().encode(JSON.stringify(projected)).byteLength;
    // Real self-atlas projection is 8.46 MiB (5,507 entities / 13,003 relations).
    if(graphBytes>12*1024*1024) throw new Error('graph limit');
  };
  const reader=object.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
  try {
    while(true) {
      const next=await reader.read();if(next.done) break;
      rawBytes+=next.value.byteLength;if(rawBytes>maximum) throw new Error('raw limit');
      for(let offset=0;offset<next.value.byteLength;offset+=16*1024) {
        const chunk=next.value.subarray(offset,offset+16*1024);
        pendingBytes+=chunk.byteLength;if(pendingBytes>2*1024*1024) throw new Error('value limit');
        const decoded=decoder.decode(chunk,{stream:true});if(decoded) parser.write(decoded);
      }
    }
    const tail=decoder.decode();if(tail) parser.write(tail);
    if(!parser.isEnded) parser.end();
    if(!parser.isEnded || !entitiesSeen || !relationsSeen) throw new Error('incomplete');
    return result;
  } catch(error) { void reader.cancel().catch(()=>undefined);throw error; }
}

function name(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) invalid(); return value; }
function page(args: Record<string, unknown>): { limit: number; cursor?: string } {
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50)) invalid();
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 8192)) invalid();
  return { limit: args.limit === undefined ? 25 : Number(args.limit), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) };
}
async function listing(bucket: R2Bucket): Promise<Record<string, unknown>[]> {
  const index = record(await objectJson(bucket, publishedIndexKey(), MAX_METADATA_BYTES));
  if (index.schema !== PUBLISHED_INDEX_SCHEMA || !Array.isArray(index.repos)) return [];
  return index.repos.map(record).filter(row => typeof row.slug === 'string' && isPublishedSlug(row.slug) && typeof row.versionId === 'string' && isPublishedVersionId(row.versionId) && typeof row.owner === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(row.owner) && typeof row.repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(row.repo) && typeof row.commitSha === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(row.commitSha));
}
function attribution(row: Record<string, unknown>): Record<string, unknown> {
  const owner = String(row.owner), repo = String(row.repo), commitSha = String(row.commitSha);
  const raw = record(row.license);
  let license: Record<string, unknown> = { state: 'unknown' };
  if (typeof raw.spdxId === 'string' && raw.spdxId.length <= 128 && /^[A-Za-z0-9.()+ -]+$/.test(raw.spdxId) && typeof raw.name === 'string') {
    license = { state: 'recorded', spdxId: raw.spdxId, name: agentPublicText(raw.name, 256) };
    if (typeof raw.url === 'string') {
      try {
        const url = new URL(raw.url);
        const prefix = `/${owner}/${repo}/blob/${commitSha}/`;
        if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname.startsWith(prefix) && !/%2f|%5c|%2e/i.test(url.pathname)) license.url = url.href;
      } catch { /* invalid attribution link is omitted */ }
    }
  }
  return { repositoryUrl: `https://github.com/${owner}/${repo}/tree/${commitSha}`, license };
}
function atlasLink(slug: unknown, publicOrigin: string): Record<string, unknown> {
  const path = canonicalAtlasPathForSlug(slug);
  // The browser currently opens the latest publication, not the tool's immutable pin.
  return path ? { atlasUrl: new URL(path, publicOrigin).href, atlasUrlVersion: 'latest' } : {};
}
function publicAtlas(row: Record<string, unknown>, publicOrigin: string): Record<string, unknown> {
  return { owner: row.owner, repo: row.repo, versionId: row.versionId, commitSha: row.commitSha, ...atlasLink(row.slug, publicOrigin), ...attribution(row), ...(typeof row.description === 'string' ? { description: agentPublicText(row.description, 280) } : {}), ...(typeof row.language === 'string' ? { language: agentPublicText(row.language, 40) } : {}) };
}
/** Public read-only service: no container, gateway, private object or source network access. */
export async function executeAgentTool(tool: string, input: unknown, context: { bucket: R2Bucket; publicOrigin?: string; now?: number }): Promise<Record<string, unknown>> {
  try { return await execute(tool, input, context.bucket, context.publicOrigin ?? 'https://sourcefor.dev', context.now ?? Date.now()); }
  catch (error) { if (error instanceof AgentAtlasError) throw error; throw new AgentAtlasError('unavailable', 'Published atlas data is unavailable.'); }
}
async function execute(tool: string, input: unknown, bucket: R2Bucket, publicOrigin: string, now: number): Promise<Record<string, unknown>> {
  if (!AGENT_TOOL_DESCRIPTORS.some(item => item.name === tool)) invalid();
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const args = record(input);
  const pagination = page(args);
  if (tool === 'get_evidence' && (args.sourcePath !== undefined && (typeof args.sourcePath !== 'string' || args.sourcePath.length > 512 || !agentRepositoryPath(args.sourcePath))
    || args.sourceLine !== undefined && (typeof args.sourceLine !== 'number' || !Number.isSafeInteger(args.sourceLine) || args.sourceLine < 1))) invalid();
  const rows = await listing(bucket);
  if (tool === 'list_atlases') {
    const sorted = rows.sort((a,b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sorted.map(row => [publicAtlas(row, publicOrigin), publicationTimestamp(row.snapshotGeneratedAt), publicationTimestamp(row.publishedAt)])))))).map(byte => byte.toString(16).padStart(2,'0')).join('');
    const parts = typeof args.cursor === 'string' ? /^(\d{1,8}):([a-f0-9]{64})$/.exec(args.cursor) : undefined;
    if (args.cursor !== undefined && (!parts || parts[2] !== digest)) invalid();
    const cursor = parts ? Number(parts[1]) : 0;
    const items = sorted.slice(cursor,cursor+pagination.limit).map(row => ({ ...publicAtlas(row, publicOrigin), freshness: agentPublicationFreshness({ ...row, generatedAt: row.snapshotGeneratedAt },now) }));
    return { atlases: items, ...(cursor+pagination.limit < sorted.length ? { nextCursor: `${cursor+pagination.limit}:${digest}` } : {}) };
  }
  const requested = record(args.atlas);
  const owner = name(requested.owner), repo = name(requested.repo);
  if (typeof requested.versionId !== 'string' || !isPublishedVersionId(requested.versionId)) invalid();
  const versionId = requested.versionId;
  const row = rows.find(item => String(item.owner).toLowerCase() === owner.toLowerCase() && String(item.repo).toLowerCase() === repo.toLowerCase());
  if (!row) missing();
  const slug = String(row.slug);
  // Existence remains the publication enablement gate; pointer contents only enrich freshness.
  const latestKey = publishedLatestKey(slug);
  if (!await bucket.head(latestKey)) missing();
  let latestValue: unknown;
  try { latestValue = await objectJson(bucket,latestKey,MAX_METADATA_BYTES); }
  catch { /* An unreadable pointer cannot invalidate intact, explicitly pinned evidence. */ }
  const latest = record(latestValue);
  const latestVersionId = latest.schema === PUBLISHED_LATEST_SCHEMA && latest.slug === slug
    && typeof latest.versionId === 'string' && isPublishedVersionId(latest.versionId) ? latest.versionId : undefined;
  const manifest = record(await objectJson(bucket,publishedManifestKey(slug,versionId),MAX_METADATA_BYTES));
  if (manifest.schema !== PUBLISHED_VERSION_SCHEMA || manifest.slug !== slug || manifest.versionId !== versionId || String(manifest.owner).toLowerCase() !== owner.toLowerCase() || String(manifest.repo).toLowerCase() !== repo.toLowerCase() || (typeof manifest.commitSha !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(manifest.commitSha))) missing();
  const snapshotValue = await publicSnapshot(bucket,publishedPublicFileKey(slug,versionId,'snapshot.json'));
  if (snapshotValue.schemaVersion !== 1 || !Array.isArray(snapshotValue.entities) || !Array.isArray(snapshotValue.relations) || snapshotValue.commitSha !== manifest.commitSha || typeof snapshotValue.id !== 'string') missing();
  const snapshot = snapshotValue as unknown as ArchitectureSnapshot;
  const atlas = { owner: row.owner, repo: row.repo, versionId, commitSha: manifest.commitSha, freshness: agentPublicationFreshness({ versionId, publishedAt: manifest.publishedAt, generatedAt: snapshot.generatedAt },now,latestVersionId), ...atlasLink(slug, publicOrigin), ...attribution({ owner: row.owner, repo: row.repo, commitSha: manifest.commitSha, license: manifest.license }) };
  // Public accepted summaries are version-pinned alongside the graph. Never consult the private sidecar.
  const explanations = new Map<string,unknown>();
  if (tool === 'search_atlas' || tool === 'get_entity') {
    const sidecar = record(await objectJson(bucket,publishedPublicFileKey(slug,versionId,'operator-explanations.json'),4*1024*1024));
    if (sidecar.versionId === versionId && Array.isArray(sidecar.explanations) && sidecar.explanations.length <= 100000) {
      for (const item of sidecar.explanations) {
        const row = record(item);
        if (typeof row.entityId === 'string' && row.entityId.length <= 512) explanations.set(row.entityId,row);
      }
    }
  }
  if (tool === 'search_atlas') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256 || (args.rootEntityId !== undefined && (typeof args.rootEntityId !== 'string' || args.rootEntityId.length > 512))) invalid();
    return { atlas, ...agentSearch(snapshot,{ query: args.query, ...pagination, explanations, cursorNamespace:versionId, ...(typeof args.rootEntityId === 'string' ? { rootEntityId: args.rootEntityId } : {}) }) };
  }
  if (typeof args.entityId !== 'string' || !args.entityId || args.entityId.length > 512) invalid();
  if (tool === 'get_entity') return { atlas, ...agentEntity(snapshot,args.entityId,explanations.get(args.entityId)) };
  if (tool === 'get_relations') return { atlas, ...agentRelations(snapshot,{entityId:args.entityId,...pagination,cursorNamespace:versionId}) };
  const entity = snapshot.entities.find(item => item.id === args.entityId);
  if (entity && !entity.sourceExcerpts?.length) {
    const url = new URL(`https://atlas-read.invalid/scan/${slug}/excerpt.json`);
    url.searchParams.set('version',versionId); url.searchParams.set('entity',args.entityId);
    const response = await handleScanRoute(new Request(url),{ bucket, backend:undefined, env:{}, waitUntil:()=>undefined, cache:undefined });
    if (response.status === 200 && response.body) {
      const packet = record(await boundedJson(response.body,MAX_METADATA_BYTES));
      if (packet.entityId === args.entityId && Array.isArray(packet.sourceExcerpts)) entity.sourceExcerpts = packet.sourceExcerpts as typeof entity.sourceExcerpts;
    }
  }
  return { atlas, ...agentEvidence(snapshot,args.entityId, {
    ...(typeof args.sourcePath === 'string' ? { sourcePath: args.sourcePath } : {}),
    ...(typeof args.sourceLine === 'number' ? { sourceLine: args.sourceLine } : {}),
  }) };
}
