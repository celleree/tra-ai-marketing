import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryPortfolioStorage, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { finishPortfolioSlot, newCreativePortfolio, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
const fixture = vi.hoisted(() => ({ id: 'portfolio_' + 'a'.repeat(32), creatives: ['creative_' + 'b'.repeat(32), 'creative_' + 'c'.repeat(32)],
  request: { context: 'Frozen request', sourceAssets: [], placement: 'PORTRAIT_4_5', variationCount: 2 } }));
vi.mock('@/lib/creatives/preview-test-binding', () => {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonical(v[k])])) : v;
  return { PREVIEW_ADVANCE_HEADER: 'X-TRA-Preview-Advance', PREVIEW_TEST_APPROVAL: { id: 'fence-fixture', portfolioId: fixture.id,
    requestSha256: createHash('sha256').update(JSON.stringify(canonical(fixture.request))).digest('hex'), creativeIds: fixture.creatives } };
});
const mocks = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn(), update: vi.fn(), advance: vi.fn(), creatives: vi.fn(), storage: null as any }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/video/intelligence-storage', async original => ({ ...await original<typeof import('@/lib/video/intelligence-storage')>(),
  getVideoIntelligenceStorage: () => mocks.storage }));
vi.mock('@/lib/creatives/portfolio-job-storage', () => ({ readCreativePortfolio: mocks.read, updateCreativePortfolio: mocks.update, createCreativePortfolio: vi.fn() }));
vi.mock('@/lib/creatives/portfolio-execution', () => ({ advanceCreativePortfolio: mocks.advance }));
vi.mock('@/lib/creatives/portfolio-results', () => ({ readPortfolioCreatives: mocks.creatives }));
import { GET, PATCH } from '@/app/api/creatives/portfolios/route';
import { assertPreviewAdvanceDispatch, PREVIEW_ADVANCE_HEADER, stopApprovedPreviewAdvance, withApprovedPreviewAdvance } from '@/lib/creatives/preview-advance-fence';
import { withApprovedPreviewPortfolio } from '@/lib/creatives/preview-test-approval';
import { observeProviderAttempt } from '@/lib/ai/provider-telemetry';
import { portfolioCanAdvance, requestPortfolio, runPortfolio } from '@/lib/creatives/portfolio-client';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
let job: CreativePortfolioJob, storage: MemoryPortfolioStorage;
const request = (action?: string, nonce?: string) => new Request('http://localhost/api/creatives/portfolios' + (action ? '' : '?id=' + fixture.id),
  { ...(action ? { method: 'PATCH', body: JSON.stringify({ id: fixture.id, action }) } : {}),
    headers: { 'Content-Type': 'application/json', ...(nonce ? { [PREVIEW_ADVANCE_HEADER]: nonce } : {}) } });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('VERCEL_ENV','preview'); vi.stubEnv('TRA_IMAGE_PURPOSE','staging-smoke');
  vi.spyOn(console,'error').mockImplementation(()=>{});
  storage = new MemoryPortfolioStorage(); mocks.storage = storage;
  job = newCreativePortfolio(fixture.request as any); job.id = fixture.id;
  job.slots.forEach((slot,i)=>{slot.creativeId=fixture.creatives[i];});
  job.snapshot = portfolioSnapshot(job); job.planning = { phase: 'READY_TO_RENDER' };
  mocks.access.mockResolvedValue({allowed:true,userId:'operator'});
  mocks.read.mockImplementation(async()=>structuredClone(job));
  mocks.update.mockImplementation(async (_id,change)=>{job=change(structuredClone(job));return structuredClone(job);});
  mocks.advance.mockImplementation(async()=>({job:structuredClone(job)})); mocks.creatives.mockResolvedValue([]);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('one approved Preview advance fence',()=>{
  it.each(['initial-read','reconcile','result-read','committed-checkpoint'])('stops the entire admitted %s error path before later purchases',async phase=>{
    if(phase==='initial-read') mocks.read.mockRejectedValueOnce(new Error('Transient job read'));
    if(phase==='result-read') mocks.creatives.mockRejectedValueOnce(new Error('Transient result read'));
    if(phase==='reconcile'||phase==='committed-checkpoint') mocks.advance.mockImplementationOnce(async()=>{
      if(phase==='committed-checkpoint') job.slots[0].status='SAVED';
      throw new Error('Transient pre-claim or lost checkpoint acknowledgement');
    });
    const failed=await PATCH(request('advance')); expect(failed.status).toBe(500);
    expect(await failed.json()).not.toHaveProperty('previewAdvanceNonce');
    expect(job.previewAcceptanceError).toBeTruthy();
    const count=mocks.advance.mock.calls.length;
    const read=await(await GET(request())).json(); expect(portfolioCanAdvance(read.job,true)).toBe(false);
    expect(read).not.toHaveProperty('previewAdvanceNonce');
    await PATCH(request('advance'));expect(mocks.advance).toHaveBeenCalledTimes(count);
    expect(job.slots[1].status).toBe('PENDING');
  });
  it('keeps the committed fence closed when both stop writes fail after a saved checkpoint',async()=>{
    const write=storage.write.bind(storage);
    storage.write=async(key,bytes,etag)=>{if(key.endsWith('/stopped.json'))throw new Error('Stop write unavailable');return write(key,bytes,etag);};
    mocks.update.mockRejectedValue(new Error('Job stop write unavailable'));
    mocks.advance.mockImplementationOnce(async()=>{job.slots[0].status='SAVED';throw new Error('Lost checkpoint acknowledgement');});
    const failed = await PATCH(request('advance'));
    expect(failed.status).toBe(409);expect((await failed.json()).error).toContain('persistence could not be confirmed');
    expect(job.previewAcceptanceError).toBeUndefined();
    const refreshed=await(await GET(request())).json();expect(refreshed.job.previewAcceptanceError).toBeTruthy();
    expect(portfolioCanAdvance(refreshed.job,true)).toBe(false);
    await PATCH(request('advance'));expect(mocks.advance).toHaveBeenCalledOnce();expect(job.slots[1].status).toBe('PENDING');
  });
  it('requires the delivered nonce across refresh and never recovers it from GET',async()=>{
    const first=await(await PATCH(request('advance'))).json();expect(first.previewAdvanceNonce).toMatch(/^[a-f0-9]{32}$/);
    const refreshed=await(await GET(request(undefined,first.previewAdvanceNonce))).json();
    expect(refreshed.job.previewAcceptanceError).toBeUndefined();expect(refreshed).not.toHaveProperty('previewAdvanceNonce');
    const unknown=await(await GET(request())).json();expect(portfolioCanAdvance(unknown.job,true)).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    const second=await(await PATCH(request('advance',first.previewAdvanceNonce))).json();
    expect(second.previewAdvanceNonce).not.toBe(first.previewAdvanceNonce);expect(mocks.advance).toHaveBeenCalledTimes(2);
  });
  it.each(['busy','terminal','child-unknown'])('withholds continuation authority for %s work',async state=>{
    mocks.advance.mockImplementationOnce(async()=>{
      if(state==='busy') job.lease={id:'worker',slotIndex:1,expiresAtMs:Date.now()+10000};
      if(state==='terminal') job.slots[0]={...job.slots[0],status:'RETRY_REQUIRED',error:'Unknown image'};
      if(state==='child-unknown') {job.snapshot=null;job.planning={phase:'INITIAL_PLAN',preparation:{quotaReserved:true,
        videoProgress:{mediaId:'media_'+'d'.repeat(32),phase:'RETRY_REQUIRED',busy:false,completedRepresentatives:0,totalRepresentatives:2}}};}
      return{job:structuredClone(job)};
    });
    const value=await(await PATCH(request('advance'))).json();expect(value).not.toHaveProperty('previewAdvanceNonce');
    await PATCH(request('advance'));expect(mocks.advance).toHaveBeenCalledOnce();
  });
  it('preserves an active lease and purchased output while independently denying every later dispatch',async()=>{
    const meta={attemptId:'mock',portfolioId:fixture.id,stage:'creative-plan',endpoint:'responses' as const,model:'gpt-6.1-sol',purpose:'staging-smoke' as const};
    const dispatch=vi.fn(async()=>Response.json({status:'completed'}));
    await withApprovedPreviewAdvance(fixture.id,undefined,async()=>{
      job.lease={id:'owner-A',slotIndex:1,expiresAtMs:Date.now()+10000};const lease=structuredClone(job.lease);
      await stopApprovedPreviewAdvance(fixture.id,storage);expect(job.lease).toEqual(lease);
      expect(parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)),job.id).lease).toEqual(lease);
      await expect(withApprovedPreviewPortfolio(job,storage,()=>observeProviderAttempt(meta,dispatch))).rejects.toThrow('test is stopped');
      job=finishPortfolioSlot(job,'owner-A',job.slots[0].creativeId);
      expect(job.slots[0].status).toBe('SAVED');expect(job.previewAcceptanceError).toBeTruthy();expect(dispatch).not.toHaveBeenCalled();
    },storage);
  });
  it('checks this request nonce again before purchase after a newer request consumes the fence',async()=>{
    const meta={attemptId:'mock',portfolioId:fixture.id,stage:'creative-plan',endpoint:'responses' as const,model:'gpt-6.1-sol',purpose:'staging-smoke' as const};
    await withApprovedPreviewAdvance(fixture.id,undefined,async nonce=>{
      await withApprovedPreviewAdvance(fixture.id,nonce,async()=>{},storage);
      await expect(assertPreviewAdvanceDispatch(meta)).rejects.toThrow('test is stopped');
    },storage);
  });
  it('keeps a committed fence closed after the reservation acknowledgement is lost',async()=>{
    const write=storage.write.bind(storage);let lost=false;
    storage.write=async(key,bytes,etag)=>{const saved=await write(key,bytes,etag);if(!lost&&key.endsWith('/advance-fence.json')){lost=true;throw new Error('Lost reservation acknowledgement');}return saved;};
    expect((await PATCH(request('advance'))).status).toBe(500);expect(mocks.advance).not.toHaveBeenCalled();
    await PATCH(request('advance'));expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('persists continuation only after full client validation and retains it across load',async()=>{
    const values=new Map<string,string>();vi.stubGlobal('window',{sessionStorage:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)}});
    const fetcher=vi.fn(async(_url:any,init:any)=>init.method==='GET'?GET(request(undefined,init.headers?.[PREVIEW_ADVANCE_HEADER]))
      :PATCH(request('advance',init.headers?.[PREVIEW_ADVANCE_HEADER])));vi.stubGlobal('fetch',fetcher);
    const first=await requestPortfolio({action:'advance',id:fixture.id});expect(values.size).toBe(1);
    const loaded=await requestPortfolio({action:'load',id:fixture.id});expect(loaded.job.previewAcceptanceError).toBeUndefined();
    await requestPortfolio({action:'advance',id:fixture.id});expect(mocks.advance).toHaveBeenCalledTimes(2);
    expect(first.job.id).toBe(fixture.id);expect(fetcher.mock.calls[1][1].headers?.[PREVIEW_ADVANCE_HEADER]).toMatch(/^[a-f0-9]{32}$/);
  });
  it.each(['invalid-nonce','unsaved-creative','session-write'])('never grants client continuation after %s failure',async failure=>{
    const values=new Map<string,string>();vi.stubGlobal('window',{sessionStorage:{getItem:(k:string)=>values.get(k)??null,
      setItem:(k:string,v:string)=>{if(failure==='session-write')throw new Error('Session storage unavailable');values.set(k,v);}}});
    const response=await PATCH(request('advance'));const value=await response.json();
    if(failure==='invalid-nonce')value.previewAdvanceNonce='invalid';
    if(failure==='unsaved-creative')value.creatives=[{id:fixture.creatives[0]}];
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json(value)));
    await expect(requestPortfolio({action:'advance',id:fixture.id})).rejects.toThrow();
    expect([...values.values()]).toEqual(failure==='session-write'?[]:['stopped']);
    expect(portfolioCanAdvance((await(await GET(request())).json()).job,true)).toBe(false);
  });
  it.each(['unchanged-progress','load-response'])('invalidates a received receipt after a later client %s error',async failure=>{
    const values=new Map<string,string>();vi.stubGlobal('window',{sessionStorage:{getItem:(k:string)=>values.get(k)??null,
      setItem:(k:string,v:string)=>values.set(k,v)}});
    const fetcher=vi.fn(async(_url:any,init:any)=>init.method==='GET'?GET(request(undefined,init.headers?.[PREVIEW_ADVANCE_HEADER]))
      :PATCH(request('advance',init.headers?.[PREVIEW_ADVANCE_HEADER])));vi.stubGlobal('fetch',fetcher);
    const initial=await requestPortfolio({action:'load',id:fixture.id});
    if(failure==='unchanged-progress') await expect(runPortfolio(initial,()=>{},()=>false)).rejects.toThrow('did not advance');
    else {
      await requestPortfolio({action:'advance',id:fixture.id});
      fetcher.mockRejectedValueOnce(new Error('Read response lost'));
      await expect(requestPortfolio({action:'load',id:fixture.id})).rejects.toThrow('Read response lost');
    }
    expect([...values.values()]).toEqual(['stopped']);
    expect(portfolioCanAdvance((await requestPortfolio({action:'load',id:fixture.id})).job,true)).toBe(false);
    const count=mocks.advance.mock.calls.length;
    await requestPortfolio({action:'advance',id:fixture.id}).catch(()=>{});expect(mocks.advance).toHaveBeenCalledTimes(count);
  });
});
