import { beforeEach, describe, expect, it } from 'vitest';
import { resetPackIndexCache } from '../src/scan';
import { executeAgentTool } from '../src/agentAtlas';
import { PUBLISHED_LATEST_SCHEMA, PUBLISHED_VERSION_SCHEMA, publishedLatestKey, publishedManifestKey, publishedIndexKey, publishedPublicFileKey } from '../../server/src/publishedStoreLayout';
import { edgeEnv, seedAtlas, seedIndex } from './helpers';
const context = { bucket: edgeEnv.ATLAS_BUCKET };
const atlas = { owner:'agent-test',repo:'public',versionId:'v1' };
const slug = 'agent-test__public';
const entity = { id:'system',kind:'softwareSystem',name:'Public system',band:'L1',sourceRefs:[{path:'src/main.ts',commitSha:'abc123',startLine:1,endLine:2}], secret:'PRIVATE_FIELD' };
function snapshot(commitSha = 'abc123') { return {schemaVersion:1,id:'snapshot-v1',repositoryId:'repo',commitSha,generatedAt:'2026-10-01',entities:[entity,{...entity,id:'deep',name:'Deep complete entity',band:'L4'}],relations:[]}; }
async function seed(options: {manifestVersion?:string;snapshotCommit?:string;excerpt?:boolean;windows?:number} = {}) {
  await seedIndex([{slug,versionId:'v1'}]);
  await seedAtlas({slug,versionId:'v1',files:{'snapshot.json':JSON.stringify(snapshot(options.snapshotCommit))},privateFiles:{'operator-explanations.json':'PRIVATE_OPERATOR_SECRET'},packs:{neighborhood:{'':JSON.stringify({snapshot:{...snapshot(),entities:[entity]}})},...(options.excerpt ? {excerpt:{system:JSON.stringify({entityId:'system',sourceExcerpts:Array.from({length:options.windows ?? 1},(_,i)=>({path:'src/main.ts',language:'typescript',startLine:1+i*100,endLine:2+i*100,highlightLine:1+i*100,frozenRevision:'abc123',lines:['export const x = 1;','x();'],text:'export const x = 1;\nx();'}))})}} : {})}});
  await context.bucket.put(publishedManifestKey(slug,'v1'),JSON.stringify({schema:PUBLISHED_VERSION_SCHEMA,slug,owner:'agent-test',repo:'public',versionId:options.manifestVersion ?? 'v1',commitSha:'abc123',private:{secret:'PRIVATE_MANIFEST_KEY'},artifactRevisionId:'/Users/private/path'}));
}
describe('public agent atlas reads',()=>{
  // Tests replace the same fixture version; real published versions and their pack indexes are immutable.
  beforeEach(() => resetPackIndexCache());
  it('links the visual atlas separately from frozen source and labels the latest publication',async()=>{
    await seed();
    const local = { ...context, publicOrigin:'http://localhost:4316' };
    expect(await executeAgentTool('list_atlases',{},local)).toMatchObject({atlases:[{atlasUrl:'http://localhost:4316/r/agent-test/public',atlasUrlVersion:'latest',versionId:'v1',repositoryUrl:'https://github.com/agent-test/public/tree/abc123'}]});
    for (const tool of ['search_atlas','get_entity','get_relations','get_evidence']) {
      expect(await executeAgentTool(tool,{atlas,entityId:'system',query:'Public'},local)).toMatchObject({atlas:{atlasUrl:'http://localhost:4316/r/agent-test/public',atlasUrlVersion:'latest',versionId:'v1',commitSha:'abc123'}});
    }
  });
  it('reports pinned publication age independently of scan time across all reads',async()=>{
    await seed();
    const key=publishedManifestKey(slug,'v1');
    const manifest=await (await context.bucket.get(key))!.json<Record<string,unknown>>();
    manifest.publishedAt='2026-10-01T12:00:00Z';
    await context.bucket.put(key,JSON.stringify(manifest));
    await context.bucket.put(publishedPublicFileKey(slug,'v1','snapshot.json'),JSON.stringify({...snapshot(),generatedAt:'2026-09-01T00:00:00Z'}));
    const fixed={...context,now:Date.parse('2026-10-03T12:00:00Z')};
    for(const tool of ['search_atlas','get_entity','get_relations','get_evidence']) {
      expect(await executeAgentTool(tool,{atlas,entityId:'system',query:'Public'},fixed)).toMatchObject({atlas:{versionId:'v1',commitSha:'abc123',freshness:{generatedAt:'2026-09-01T00:00:00.000Z',publishedAt:'2026-10-01T12:00:00.000Z',publicationAgeSeconds:172800,latestPublishedVersionId:'v1',evidenceComparedWithLatestPublication:'matches',currentRepositoryRevision:'not-checked'}}});
    }
    // A newer publication in the directory is not evidence of current upstream HEAD.
    await context.bucket.put(publishedLatestKey(slug),JSON.stringify({schema:PUBLISHED_LATEST_SCHEMA,slug,versionId:'v2',publishedAt:'2026-10-03T11:00:00Z'}));
    expect(await executeAgentTool('get_entity',{atlas,entityId:'system'},fixed)).toMatchObject({atlas:{versionId:'v1',freshness:{publishedAt:'2026-10-01T12:00:00.000Z',latestPublishedVersionId:'v2',evidenceComparedWithLatestPublication:'differs',currentRepositoryRevision:'not-checked'}}});
  });
  it('retains unknown times and latest identity without borrowing pointer or index dates',async()=>{
    await seed();
    expect(await executeAgentTool('get_entity',{atlas,entityId:'system'},context)).toMatchObject({atlas:{freshness:{publishedAt:null,generatedAt:null,publicationAgeSeconds:null}}});
    await context.bucket.put(publishedLatestKey(slug),JSON.stringify({schema:PUBLISHED_LATEST_SCHEMA,slug:'wrong',versionId:'v2'}));
    expect(await executeAgentTool('get_entity',{atlas,entityId:'system'},context)).toMatchObject({atlas:{freshness:{latestPublishedVersionId:null,evidenceComparedWithLatestPublication:'unknown',currentRepositoryRevision:'not-checked'}}});
    expect(await executeAgentTool('list_atlases',{},context)).toMatchObject({atlases:[{freshness:{publishedAt:'2026-09-30T00:00:00.000Z',generatedAt:'2026-09-30T00:00:00.000Z',evidenceComparedWithLatestPublication:'unknown'}}]});
  });
  it('keeps directory pagination valid as ages change but invalidates changed recorded times',async()=>{
    await seedIndex([{slug,versionId:'v1'},{slug:'second__repo',versionId:'v2'}]);
    const now=Date.parse('2026-10-03T12:00:00Z');
    const first=await executeAgentTool('list_atlases',{limit:1},{...context,now});
    expect(await executeAgentTool('list_atlases',{limit:1,cursor:first.nextCursor},{...context,now:now+86400000})).toMatchObject({atlases:[{freshness:{publicationAgeContext:'Published 4 days ago.'}}]});
    const index=await (await context.bucket.get(publishedIndexKey()))!.json<{repos:Record<string,unknown>[]}>();
    index.repos[0]!.publishedAt='2026-10-02T00:00:00Z';
    await context.bucket.put(publishedIndexKey(),JSON.stringify(index));
    await expect(executeAgentTool('list_atlases',{limit:1,cursor:first.nextCursor},{...context,now})).rejects.toMatchObject({code:'invalid_arguments'});
  });
  it('projects listing fields and reads the complete public snapshot, never the truncated neighborhood',async()=>{
    await seed();
    const list = await executeAgentTool('list_atlases',{},context);
    expect(JSON.stringify(list)).not.toContain('slug');
    const result = await executeAgentTool('get_entity',{atlas,entityId:'deep'},context);
    expect(result).toMatchObject({atlas:{versionId:'v1',commitSha:'abc123'},found:true,entity:{id:'deep'}});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|artifactRevisionId|\/Users/);
  });
  it('requires an immutable pin and refuses missing versions or inconsistent manifests/snapshots',async()=>{
    await seed();
    await expect(executeAgentTool('get_entity',{atlas:{owner:atlas.owner,repo:atlas.repo},entityId:'system'},context)).rejects.toMatchObject({code:'invalid_arguments'});
    await expect(executeAgentTool('get_entity',{atlas:{...atlas,versionId:'unknown'},entityId:'system'},context)).rejects.toMatchObject({code:'not_found'});
    await seed({manifestVersion:'wrong'});
    await expect(executeAgentTool('get_entity',{atlas,entityId:'system'},context)).rejects.toMatchObject({code:'not_found'});
    await seed({snapshotCommit:'wrong'});
    await expect(executeAgentTool('get_entity',{atlas,entityId:'system'},context)).rejects.toMatchObject({code:'not_found'});
  });
  it('reports missing evidence accurately then serves only a captured public excerpt packet',async()=>{
    await seed();
    const missing = await executeAgentTool('get_evidence',{atlas,entityId:'system'},context);
    expect(missing).toMatchObject({status:'not-captured',scanCoverage:'unknown'});
    await seed({excerpt:true});
    const captured = await executeAgentTool('get_evidence',{atlas,entityId:'system'},context);
    expect(captured).toMatchObject({status:'captured',scanCoverage:'unknown'});
    expect(JSON.stringify(captured)).toContain('export const x = 1');
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_OPERATOR_SECRET');
  });
  it('selects a late window from a pinned public pack and refuses invalid selectors',async()=>{
    await seed({excerpt:true,windows:12});
    const selected = await executeAgentTool('get_evidence',{atlas,entityId:'system',sourcePath:'src/main.ts',sourceLine:1102},context);
    expect(selected).toMatchObject({atlas:{versionId:'v1',commitSha:'abc123'},status:'captured',excerpts:[{startLine:1101,endLine:1102}]});
    expect(await executeAgentTool('get_evidence',{atlas,entityId:'system',sourceLine:5234},context)).toMatchObject({status:'not-captured',excerpts:[],scanCoverage:'unknown'});
    for(const selection of [{sourceLine:0},{sourceLine:1.5},{sourceLine:'2'},{sourcePath:'../private.ts'},{sourcePath:'/Users/private/a.ts'}]) {
      await expect(executeAgentTool('get_evidence',{atlas,entityId:'system',...selection},context)).rejects.toMatchObject({code:'invalid_arguments'});
    }
  });
  it('returns commit-pinned attribution and scrubs free-form listing fields',async()=>{
    await seed();
    const index = await (await context.bucket.get(publishedIndexKey()))!.json<{repos:Record<string,unknown>[]}>();
    index.repos[0]!.description = 'API_KEY=superSecret /Users/private/path';
    index.repos[0]!.language = 'Bearer abcSuperSecret';
    index.repos[0]!.license = {spdxId:'MIT',name:'MIT License',url:'https://github.com/agent-test/public/blob/abc123/LICENSE',private:'PRIVATE_LICENSE'};
    await context.bucket.put(publishedIndexKey(),JSON.stringify(index));
    const listed = await executeAgentTool('list_atlases',{},context);
    expect(listed).toMatchObject({atlases:[{repositoryUrl:'https://github.com/agent-test/public/tree/abc123',license:{state:'recorded',spdxId:'MIT',url:'https://github.com/agent-test/public/blob/abc123/LICENSE'}}]});
    expect(JSON.stringify(listed)).not.toMatch(/superSecret|abcSuperSecret|\/Users|PRIVATE_LICENSE/);
    const key = publishedManifestKey(slug,'v1');
    const manifest = await (await context.bucket.get(key))!.json<Record<string,unknown>>();
    manifest.license = {spdxId:'MIT',name:'MIT License',url:'https://evil.example/private',private:'PRIVATE_LICENSE'};
    await context.bucket.put(key,JSON.stringify(manifest));
    const detail = await executeAgentTool('get_entity',{atlas,entityId:'system'},context);
    expect(detail).toMatchObject({atlas:{repositoryUrl:'https://github.com/agent-test/public/tree/abc123',license:{state:'recorded',spdxId:'MIT'}}});
    expect(JSON.stringify(detail)).not.toMatch(/evil.example|PRIVATE_LICENSE/);
    delete manifest.license;
    await context.bucket.put(key,JSON.stringify(manifest));
    expect(await executeAgentTool('get_entity',{atlas,entityId:'system'},context)).toMatchObject({atlas:{license:{state:'unknown'}}});
    await context.bucket.put(publishedPublicFileKey(slug,'v1','snapshot.json'),JSON.stringify({...snapshot(),schemaVersion:2}));
    await expect(executeAgentTool('get_entity',{atlas,entityId:'system'},context)).rejects.toMatchObject({code:'not_found'});
  });
  it('bounds snapshot reads and never requests a private object',async()=>{
    await seed();
    const keys:string[]=[];
    const bucket = new Proxy(context.bucket,{get(target,property){
      if(property === 'get') return async(key:string,...rest:unknown[])=>{
        keys.push(key);
        if(key.endsWith('/public/snapshot.json')) return {size:64*1024*1024+1,body:new ReadableStream({start(controller){controller.close();}})};
        return target.get(key,...rest as []);
      };
      const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(executeAgentTool('get_entity',{atlas,entityId:'system'},{bucket})).rejects.toMatchObject({code:'unavailable'});
    expect(keys.some(key=>key.includes('/private/'))).toBe(false);
  });
  // This is a large-input correctness test, including fixture creation, R2 storage
  // and two reads. Its timeout is a safety bound, not a query latency budget.
  it('streams excerpt-heavy snapshots larger than 16MiB while retaining only bounded graph fields',async()=>{
    await seed();
    const values=Array.from({length:20000},(_,i)=>({...entity,id:`entity-${i}`,name:`Large entity ${i}`,sourceExcerpts:[{...entity,padding:'x'.repeat(1000)}],unknown:'not retained'}));
    const body=JSON.stringify({...snapshot(),entities:values});
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(16*1024*1024);
    await context.bucket.put(publishedPublicFileKey(slug,'v1','snapshot.json'),body);
    const found=await executeAgentTool('get_entity',{atlas,entityId:'entity-19999'},context);
    expect(found).toMatchObject({found:true,entity:{id:'entity-19999'}});
    expect(JSON.stringify(found)).not.toContain('padding');
    expect(await executeAgentTool('get_evidence',{atlas,entityId:'entity-19999'},context)).toMatchObject({status:'not-captured'});
  }, 20_000);
  it('reads accepted understanding only from the version-matching public sidecar',async()=>{
    await seed();
    const key=publishedPublicFileKey(slug,'v1','operator-explanations.json');
    const row={entityId:'system',state:'accepted',stale:false,explanationVersionId:'expl-1',operatorClaimMap:'PRIVATE_CLAIM_MAP',explanation:{format:'v3',summary:'Coordinates public graph reads.',keyPoints:['Explains public atlas context.'],evidence:[{entityId:'system',path:'src/main.ts',startLine:1,endLine:2}],prompts:'PRIVATE_PROMPT'}};
    await context.bucket.put(key,JSON.stringify({versionId:'v1',explanations:[row],private:'PRIVATE_OPERATOR'}));
    const detail=await executeAgentTool('get_entity',{atlas,entityId:'system'},context);
    expect(detail).toMatchObject({entity:{understanding:{summary:'Coordinates public graph reads.',state:'accepted',stale:false,provenance:'published-explanation'}}});
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_/);
    const search=await executeAgentTool('search_atlas',{atlas,query:'Coordinates'},context);
    expect(search).toMatchObject({items:[{id:'system'}]});
    await context.bucket.put(key,JSON.stringify({versionId:'wrong',explanations:[row]}));
    const wrong=await executeAgentTool('get_entity',{atlas,entityId:'system'},context);
    expect((wrong.entity as Record<string,unknown>).understanding).toBeUndefined();
    await context.bucket.delete(key);
    expect((await executeAgentTool('get_entity',{atlas,entityId:'system'},context)).found).toBe(true);
  });
  it('preserves literal stable IDs for entities and public evidence pack keys',async()=>{
    const id='code:apps-server-src-ask-eval-live-ts:ask-eval-replay-call';
    await seed();
    await seedAtlas({slug,versionId:'v1',files:{'snapshot.json':JSON.stringify({...snapshot(),entities:[{...entity,id}]})},packs:{excerpt:{[id]:JSON.stringify({entityId:id,sourceExcerpts:[{path:'src/main.ts',language:'typescript',startLine:1,endLine:1,highlightLine:1,frozenRevision:'abc123',lines:['replay();'],text:'replay();'}]})}}});
    await context.bucket.put(publishedManifestKey(slug,'v1'),JSON.stringify({schema:PUBLISHED_VERSION_SCHEMA,slug,owner:'agent-test',repo:'public',versionId:'v1',commitSha:'abc123'}));
    expect(await executeAgentTool('get_entity',{atlas,entityId:id},context)).toMatchObject({found:true,entity:{id}});
    expect(await executeAgentTool('get_evidence',{atlas,entityId:id},context)).toMatchObject({status:'captured'});
  });
  it('marks omitted source references as truncated evidence',async()=>{
    await seed();
    const refs=Array.from({length:20},(_,i)=>({path:`src/file${i}.ts`,commitSha:'abc123'}));
    await context.bucket.put(publishedPublicFileKey(slug,'v1','snapshot.json'),JSON.stringify({...snapshot(),entities:[{...entity,id:'references-only',sourceRefs:refs}]}));
    expect(await executeAgentTool('get_evidence',{atlas,entityId:'references-only'},context)).toMatchObject({status:'not-captured',truncated:true});
  });
  it('drops host paths without inventing redacted repository paths',async()=>{
    await seed();
    await context.bucket.put(publishedPublicFileKey(slug,'v1','snapshot.json'),JSON.stringify({...snapshot(),entities:[{...entity,sourceRefs:[{path:'/Users/private/work.ts',commitSha:'abc123'}]}]}));
    const result=await executeAgentTool('get_entity',{atlas,entityId:'system'},context);
    expect(result).toMatchObject({entity:{sourceRefs:[]}});
    expect(JSON.stringify(result)).not.toContain('redacted-host-path');
  });
  it('rejects projected graphs above the measured 12MiB safety cap',async()=>{
    await seed();
    const entities=Array.from({length:8000},(_,i)=>({...entity,id:`large-${i}`,responsibility:'x'.repeat(1600)}));
    await context.bucket.put(publishedPublicFileKey(slug,'v1','snapshot.json'),JSON.stringify({...snapshot(),entities}));
    await expect(executeAgentTool('get_entity',{atlas,entityId:'large-0'},context)).rejects.toMatchObject({code:'unavailable'});
  });
  it('fails closed on malformed UTF8, incomplete JSON and a giant single token',async()=>{
    await seed();
    const key=publishedPublicFileKey(slug,'v1','snapshot.json');
    for(const body of ['{"schemaVersion":1,"entities":[',JSON.stringify({...snapshot(),unknown:'x'.repeat(150000)})]) {
      await context.bucket.put(key,body);
      await expect(executeAgentTool('get_entity',{atlas,entityId:'system'},context)).rejects.toMatchObject({code:'unavailable'});
    }
    await context.bucket.put(key,new Uint8Array([123,34,120,34,58,34,255,34,125]));
    await expect(executeAgentTool('get_entity',{atlas,entityId:'system'},context)).rejects.toMatchObject({code:'unavailable'});
  });
  it('binds listing cursors to the published version set',async()=>{
    await seedIndex([{slug,versionId:'v1'},{slug:'second__repo',versionId:'v2'}]);
    const first = await executeAgentTool('list_atlases',{limit:1},context);
    expect(typeof first.nextCursor).toBe('string');
    const second = await executeAgentTool('list_atlases',{limit:1,cursor:first.nextCursor},context);
    expect(second.atlases).toHaveLength(1);
    await seedIndex([{slug,versionId:'v3'},{slug:'second__repo',versionId:'v2'}]);
    await expect(executeAgentTool('list_atlases',{limit:1,cursor:first.nextCursor},context)).rejects.toMatchObject({code:'invalid_arguments'});
  });
  it('rejects unpublished atlases and traversal pins',async()=>{
    await seed();
    await expect(executeAgentTool('get_entity',{atlas:{...atlas,repo:'unpublished'},entityId:'system'},context)).rejects.toMatchObject({code:'not_found'});
    await expect(executeAgentTool('get_entity',{atlas:{...atlas,versionId:'../private'},entityId:'system'},context)).rejects.toMatchObject({code:'invalid_arguments'});
  });
});
