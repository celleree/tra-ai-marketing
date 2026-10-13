import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { claimCreativePortfolio, newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const fixture = vi.hoisted(() => ({
  id: 'portfolio_' + 'a'.repeat(32), context: 'Frozen selected video and four statements.',
  layout: 'exact layout bytes', frames: ['exact candidate49 bytes', 'exact candidate66 bytes'],
  creatives: ['creative_' + 'b'.repeat(32), 'creative_' + 'c'.repeat(32)],
  request: { context: 'Frozen selected video and four statements.', variationCount: 2, placement: 'PORTRAIT_4_5',
    sourceAssets: [{ role: 'TRA_VIDEO', mediaId: 'media_' + 'd'.repeat(32) }, { role: 'LAYOUT_REFERENCE', mediaId: 'media_' + 'e'.repeat(32) }],
    previewOmitBrandLogo: true, reviewHandoff: { choices: { frames: ['frame49', 'frame66'], statements: ['s1','s2','s3','s4'] } } },
}));
vi.mock('@/lib/creatives/preview-test-binding', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  const c = (v: any): any => Array.isArray(v) ? v.map(c) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k,c(v[k])])) : v;
  return { PREVIEW_ADVANCE_HEADER: 'X-TRA-Preview-Advance', PREVIEW_TEST_APPROVAL: { id: 'fixture-approval', portfolioId: fixture.id,
    assessmentContract: 'head-and-shoulders-v1',
    requestSha256: sha(JSON.stringify(c(fixture.request))), contextSha256: sha(fixture.context),
    layoutSha256: sha(fixture.layout), frameSha256s: fixture.frames.map(sha), frameCandidateIndexes: [49,66],
    creativeIds: fixture.creatives } };
});
import { isApprovedPreviewPortfolio, withApprovedPreviewPortfolio } from '@/lib/creatives/preview-test-approval';
import { fetchWithProviderUsage, withProviderUsageContext } from '@/lib/ai/provider-telemetry';
import { fetchCreativeImage } from '@/lib/creatives/image-models';
import { imageAttemptBudget, withImageAttemptScope } from '@/lib/creatives/image-attempt-execution';
import { portfolioCanAdvance, requestPortfolio, runPortfolio } from '@/lib/creatives/portfolio-client';
import { portfolioProgress } from '@/lib/creatives/portfolio-progress';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const job = () => { const value = newCreativePortfolio(fixture.request as any); value.id = fixture.id;
  value.slots.forEach((slot,i) => { slot.creativeId = fixture.creatives[i]; }); return value; };
const body = (stage: string, frame = 0) => {
  const plan = ['creative-plan','portfolio-audit'].includes(stage);
  const name = stage === 'source-reference-analysis' ? 'tra_reference_analysis' : stage === 'layout-analysis'
    ? 'layout_blueprint_v1' : 'tra_candidate_human_suitability';
  const text = stage === 'source-reference-analysis'
    ? 'Analyze this uploaded reference ad as creative inspiration for an original TRA adaptation.\n\nUser direction:\n' + fixture.context
    : stage === 'video-human-selection' ? JSON.stringify({ policy: 'human-frame-candidate-suitability-v3',
      frameSha256: sha(fixture.frames[frame]), candidateIndex: frame === 0 ? 49 : 66,
      assessmentContract: 'head-and-shoulders-v1' }) : 'Extract only geometry.';
  return { model: plan ? 'gpt-6.1-sol' : 'gpt-6-luna', store: false,
    input: [{role:'developer',content:[{type:'input_text',text:'Existing rules'}]},
      {role:'user',content:[{type:'input_text',text}, ...(plan ? [] : [{type:'input_image',
        image_url:'data:image/png;base64,' + Buffer.from(stage === 'video-human-selection' ? fixture.frames[frame] : fixture.layout).toString('base64')}])]}],
    text: {format:{name, type:'json_schema',strict:true,schema:{type:'object'}}},
    ...(stage === 'video-human-selection' ? {max_output_tokens:2048} : plan ? {max_output_tokens:stage==='creative-plan'?7168:4608} : {}),
  };
};
const scope = <T>(storage: MemoryPortfolioStorage, work:()=>Promise<T>, value=job()) =>
  withApprovedPreviewPortfolio(value,storage,()=>withProviderUsageContext({portfolioId:value.id},work));
const call = (storage:MemoryPortfolioStorage, dispatch:typeof fetch, stage='video-human-selection', frame=0, value=job(), input=body(stage,frame)) =>
  scope(storage,()=>fetchWithProviderUsage(stage,input.model,'https://api.openai.com/v1/responses',
    {method:'POST',body:JSON.stringify(input)},dispatch),value);
beforeEach(()=> {vi.stubEnv('VERCEL_ENV','preview');vi.stubEnv('TRA_IMAGE_PURPOSE','staging-smoke');
  vi.spyOn(console,'info').mockImplementation(()=>{});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('one approved Preview preparation scope',()=>{
  it('binds the new complete frozen request and creative IDs without reopening any failure',()=>{
    const saved=job(); saved.planningError='The previous assessment failed';
    expect(isApprovedPreviewPortfolio(saved)).toBe(true);
    expect(claimCreativePortfolio(saved,Date.now(),'approved-resume',true).status).toBe('BLOCKED');
    for(const mutate of [(v:any)=>{v.id='portfolio_'+'f'.repeat(32);},(v:any)=>{v.request.context+='changed';},
      (v:any)=>{v.request.reviewHandoff.choices.statements.pop();},(v:any)=>{v.request.reviewHandoff.choices.frames.reverse();},
      (v:any)=>{v.slots[0].creativeId='creative_'+'f'.repeat(32);}]) {
      const v=structuredClone(saved);mutate(v);expect(isApprovedPreviewPortfolio(v)).toBe(false);
      expect(v.planningError).toBe(saved.planningError);
    }
    for(const error of ['Provider failed','Outcome unknown','This approved Preview call was already reserved.']) {
      const v={...saved,planningError:error};expect(claimCreativePortfolio(v,Date.now(),'attempt',true).status).toBe('BLOCKED');
    }
    expect(claimCreativePortfolio({...saved,previewAcceptanceError:'Later approved-test failure'}).status).toBe('BLOCKED');
    vi.stubEnv('VERCEL_ENV','production');expect(isApprovedPreviewPortfolio(saved)).toBe(false);
  });
  it('admits exactly two new frame assessments and one plan/audit, bounds outputs and rejects every repeat',async()=>{
    const storage=new MemoryPortfolioStorage(),dispatch=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({status:'completed'}));
    const steps:[string,number][]=[['video-human-selection',0],
      ['video-human-selection',1],['creative-plan',0],['portfolio-audit',0]];
    for(const [stage,index] of steps)await call(storage,dispatch,stage,index);
    expect(dispatch).toHaveBeenCalledTimes(4);expect(storage.data.size).toBe(4);
    const requests=dispatch.mock.calls.map(([,init])=>JSON.parse(String(init?.body)));
    expect(requests.map(r=>r.max_output_tokens)).toEqual([2048,2048,7168,4608]);
    expect(requests.every(r=>r.service_tier==='default')).toBe(true);
    for(const [stage,index] of steps)await expect(call(storage,dispatch,stage,index)).rejects.toThrow('already reserved');
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
  it('makes only one purchase under concurrent delivery and retains the claim after unknown outcomes',async()=>{
    const storage=new MemoryPortfolioStorage(),dispatch=vi.fn<typeof fetch>().mockRejectedValue(new Error('Disconnected'));
    const results=await Promise.allSettled([call(storage,dispatch),call(storage,dispatch)]);
    expect(results.every(r=>r.status==='rejected')).toBe(true);expect(dispatch).toHaveBeenCalledOnce();
    await expect(call(storage,dispatch)).rejects.toThrow('already reserved');expect(dispatch).toHaveBeenCalledOnce();
  });
  it('fails closed after a lost reservation acknowledgement without dispatch',async()=>{
    const storage=new MemoryPortfolioStorage(),write=storage.write.bind(storage);
    vi.spyOn(storage,'write').mockImplementationOnce(async(...args)=>{await write(...args);throw Error('Lost acknowledgement');});
    const dispatch=vi.fn<typeof fetch>();await expect(call(storage,dispatch)).rejects.toThrow('Lost acknowledgement');
    await expect(call(storage,dispatch)).rejects.toThrow('already reserved');expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(['source-reference-analysis','layout-analysis','video-transcription','video-observation','reference-shortlist','creative-plan-repair','revision-plan'])
  ('rejects unapproved stage %s before reservations or provider dispatch',async stage=>{
    const storage=new MemoryPortfolioStorage(),dispatch=vi.fn<typeof fetch>();
    await expect(call(storage,dispatch,stage)).rejects.toThrow('before dispatch');
    expect(storage.data.size).toBe(0);expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects changed bytes/context/extra images/oversized requests/wrong models before reserving',async()=>{
    const storage=new MemoryPortfolioStorage(),dispatch=vi.fn<typeof fetch>();
    for(const mutate of [(v:any)=>{v.input[1].content[1].image_url='data:image/png;base64,Y2hhbmdlZA==';},
      (v:any)=>{v.input[1].content[0].text+='changed';},(v:any)=>{v.input[1].content.push(v.input[1].content[1]);},
      (v:any)=>{v.max_output_tokens=2049;},(v:any)=>{v.input[0].content[0].text='x'.repeat(256*1024);},
      (v:any)=>{const b=JSON.parse(v.input[1].content[0].text);delete b.assessmentContract;v.input[1].content[0].text=JSON.stringify(b);},
      (v:any)=>{v.tools=[{type:'web_search'}];}]) {
      const input=body('video-human-selection');mutate(input);
      await expect(call(storage,dispatch,'video-human-selection',0,job(),input)).rejects.toThrow();
    }
    const wrong=body('video-human-selection');wrong.model='gpt-6.1-sol';
    await expect(call(storage,dispatch,'video-human-selection',0,job(),wrong)).rejects.toThrow();
    const other=job();other.id='portfolio_'+'f'.repeat(32);
    await expect(call(storage,dispatch,'creative-plan',0,other)).rejects.toThrow('before dispatch');
    const changedFrame=body('video-human-selection'); changedFrame.input[1].content[0].text=JSON.stringify({
      policy:'human-frame-candidate-suitability-v3', assessmentContract:'head-and-shoulders-v1', frameSha256:sha(fixture.frames[0]), candidateIndex:66 });
    await expect(call(storage,dispatch,'video-human-selection',0,job(),changedFrame)).rejects.toThrow();
    expect(storage.data.size).toBe(0);expect(dispatch).not.toHaveBeenCalled();
  });
  it('retains the two-image purchase ledger and prohibits other creative IDs/fallback',async()=>{
    const storage=new MemoryPortfolioStorage(),dispatch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({data:[{b64_json:'cGl4ZWxz'}]}));
    const render=(creativeId:string,model='gpt-image-2.5-sunburst')=>scope(storage,()=>withImageAttemptScope({
      runId:'portfolio:'+fixture.id,portfolioId:fixture.id,creativeId,operationId:creativeId,storage,budget:imageAttemptBudget(2),
    },()=>fetchCreativeImage('https://api.openai.com/v1/images/edits',{method:'POST',
      body:JSON.stringify({model,prompt:'Frozen render',size:'1024x1280'})})));
    await render(fixture.creatives[0]);await render(fixture.creatives[1]);await render(fixture.creatives[0]);
    await expect(render('creative_'+'f'.repeat(32))).rejects.toThrow();
    await expect(render(fixture.creatives[0],'gpt-image-2.5-flare')).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it('advances the new run and still stops at the preparation checkpoint',async()=>{
    const saved=job();
    const progress=portfolioProgress(saved);
    expect(portfolioCanAdvance(progress)).toBe(true);
    const dispatch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({job:progress,creatives:[],previewPreparationApproved:true}));
    const loaded=await requestPortfolio({action:'load',id:saved.id});expect(loaded.previewPreparationApproved).toBe(true);
    const stopped={...loaded,job:{...progress,planningError:null,previewPreparationResume:undefined},preflightReady:true as const};
    dispatch.mockResolvedValueOnce(Response.json({...stopped,previewAdvanceNonce:'e'.repeat(32)}));
    const update=vi.fn();await runPortfolio(loaded,update,()=>false);expect(dispatch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(dispatch.mock.calls[1][1]?.body))).toEqual({action:'advance',id:saved.id});
    expect(update).toHaveBeenCalledWith(expect.objectContaining({preflightReady:true}));
  });
});
