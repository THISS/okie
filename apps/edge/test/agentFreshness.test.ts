import { describe, expect, it } from 'vitest';
import { agentPublicationFreshness, publicationTimestamp } from '../src/agentFreshness';
const now = Date.parse('2026-10-03T12:00:00Z');
describe('public publication freshness',()=>{
  it('separates scan and publication instants and never claims to check repository HEAD',()=>{
    expect(agentPublicationFreshness({versionId:'v1',generatedAt:'2026-09-01T00:00:00Z',publishedAt:'2026-10-01T12:00:00Z'},now,'v1')).toEqual({
      observedAt:'2026-10-03T12:00:00.000Z',generatedAt:'2026-09-01T00:00:00.000Z',publishedAt:'2026-10-01T12:00:00.000Z',generatedAtContext:'Recorded snapshot timestamp; not a verified scan or commit time.',publicationAgeSeconds:172800,publicationAgeContext:'Published 2 days ago.',latestPublishedVersionId:'v1',evidenceComparedWithLatestPublication:'matches',currentRepositoryRevision:'not-checked',
    });
    expect(agentPublicationFreshness({versionId:'v1'},now,'v2')).toMatchObject({publishedAt:null,generatedAt:null,publicationAgeSeconds:null,evidenceComparedWithLatestPublication:'differs',currentRepositoryRevision:'not-checked'});
    expect(agentPublicationFreshness({},now)).toMatchObject({publicationAgeContext:'Publication time unknown.',latestPublishedVersionId:null,evidenceComparedWithLatestPublication:'unknown'});
  });
  it('rejects malformed or impossible instants and treats future dates honestly',()=>{
    for(const value of [null,123,'2026-10-03','2026-02-30T00:00:00Z','2026-10-01T25:00:00Z','ghp_private','2026-10-01T12:00:00Z PRIVATE']) expect(publicationTimestamp(value)).toBeNull();
    expect(publicationTimestamp('2026-10-01T14:00:00+02:00')).toBe('2026-10-01T12:00:00.000Z');
    expect(agentPublicationFreshness({publishedAt:'2026-10-04T12:00:00Z'},now)).toMatchObject({publicationAgeSeconds:null,publicationAgeContext:'Recorded publication time is in the future; age is unknown.'});
  });
  it('uses readable singular units without confusing age with a current-code check',()=>{
    for(const [age,text] of [[0,'Published less than a minute ago.'],[60,'Published 1 minute ago.'],[3600,'Published 1 hour ago.'],[86400,'Published 1 day ago.']] as const) expect(agentPublicationFreshness({publishedAt:new Date(now-age*1000).toISOString()},now).publicationAgeContext).toBe(text);
  });
});
