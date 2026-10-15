import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {videoCasePortfolio} from '../fixtures/video-case-portfolio';
import {video} from '../fixtures/video-review-selection';
import {MemoryPortfolioStorage} from '../fixtures/creative-portfolio';
import {proposeCaseAmendment} from '@/lib/creatives/portfolio-case-amendment';
import {readCreativePortfolio,updateCreativePortfolio} from '@/lib/creatives/portfolio-job-storage';
import {providerPortraitInput,providerPortraitIdentity} from '@/lib/video/provider-portrait';
import {prepareProviderVideoFrames} from '@/lib/video/source-overlay';
import {reviseBoundCaseCrop,assessRevisedBoundCaseCrop,authorizeRevisedBoundCaseImage} from '@/lib/creatives/portfolio-bound-case-recovery';
import {retryPortfolioWork} from '@/lib/creatives/portfolio-job';
import {reserveImageAttempt} from '@/lib/creatives/image-attempt-store';
const mocks=vi.hoisted(()=>({rebuild:vi.fn(),list:vi.fn(),quota:vi.fn()}));
vi.mock('@/lib/creatives/portfolio-portrait-diagnostic',()=>({reconstructPinnedPortfolioPortrait:mocks.rebuild}));
vi.mock('@/lib/creatives/storage',()=>({listCreatives:mocks.list}));
vi.mock('@/lib/quotas/operator-quota',()=>({reserveOperatorQuota:mocks.quota}));
const quality={humanPresence:'CLEAR',facialDetail:'SUFFICIENT',eyes:'OPEN_OR_NOT_VISIBLE',blur:'CLEAR',occlusion:'NONE_OR_MINOR',expressionUsability:'NATURAL_OR_NEUTRAL',framing:'USABLE',observableReason:'Clear face.',sourceOverlay:{version:2,status:'CLEAN'}};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
beforeEach(()=>{vi.clearAllMocks();mocks.list.mockResolvedValue([]);mocks.quota.mockResolvedValue({allowed:true});vi.stubEnv('OPENAI_API_KEY','not-a-real-key');});
afterEach(()=>vi.unstubAllEnvs());
async function setup(){
 const {job,pairs,frames}=videoCasePortfolio();job.videoCaseAmendment=proposeCaseAmendment(job,pairs).amendment;job.slots[0].status='SAVED';
 const source=await sharp({create:{width:360,height:640,channels:3,background:'white'}}).png().toBuffer();
 const overlay={version:2,status:'EDGE_CROP',edge:'BOTTOM',removePermille:200,overlayDepthPermille:195};
 const frame={buffer:source,frameSha256:hash(source),byteLength:source.length,timestampMs:frames[1].timestampMs,sourceVideoMediaId:video.locator.sourceVideoMediaId,sourceVideoContentHash:video.locator.sourceVideoContentHash,sourceOverlay:overlay};
 const selection={version:3,libraryId:video.libraryId,sourceVideoMediaId:video.locator.sourceVideoMediaId,sourceVideoContentHash:video.locator.sourceVideoContentHash,librarySha256:video.librarySha256,frameIds:[frames[1].frameId],candidateBindings:[frames[1]],sourceOverlays:[overlay]} as never;
 const [old]=await prepareProviderVideoFrames([frame as never]);const original=await providerPortraitInput(selection,old,'gpt-6-luna');
 job.slots[1].status='RETRY_REQUIRED';job.slots[1].error='The actual retained portrait PNG did not pass human or overlay checks. Saved creatives remain available.';
 job.slots[1].videoSelection={version:2,selectionModel:'gpt-6-luna',selectionPolicy:'human-frame-candidate-suitability-v3',reuseContext:{version:1,frames:[]},selection,providerPortrait:original.state};
 const storage=new MemoryPortfolioStorage();const jobKey=`creative-portfolios/v1/${job.id}.json`;await storage.write(jobKey,Buffer.from(JSON.stringify(job)),null);
 const oldKey=`selections/candidates/sha256/${hash(JSON.stringify(original.identity))}.json`;
 await storage.write(oldKey,Buffer.from(JSON.stringify({version:1,identity:original.identity,status:'COMPLETE',assessment:{...quality,sourceOverlay:{version:2,status:'UNSAFE'}}})),null);
 mocks.rebuild.mockImplementation(async (current:typeof job)=>{
  const v=current.slots[1].videoSelection!;const [prepared]=await prepareProviderVideoFrames([{...frame,sourceOverlay:v.selection!.sourceOverlays![0]} as never]);
  return {frame,prepared,originalMetadata:{width:360,height:640}};
 });
 const [candidate]=await prepareProviderVideoFrames([{...frame,sourceOverlay:{version:2,status:'EDGE_CROP',edge:'BOTTOM',removePermille:437,overlayDepthPermille:437}} as never]);
 const request={frameId:frames[1].frameId,timestampMs:frames[1].timestampMs,sourceVideoContentHash:video.locator.sourceVideoContentHash,previousProviderPngSha256:original.state.providerPngSha256,sourcePngSha256:original.state.sourcePngSha256,revisedProviderPngSha256:candidate.providerPngSha256,edge:'BOTTOM' as const,removePermille:437};
 return {job,storage,request,oldKey,jobKey};
}
it('prepares once without provider, preserves saved case/output/old cache and immutable history',async()=>{
 const {job,storage,request,oldKey}=await setup();const oldRecord={bytes:Buffer.from(storage.data.get(oldKey)!.bytes),etag:storage.data.get(oldKey)!.etag};
 const revised=await reviseBoundCaseCrop(job.id,2,request,storage);expect(revised.slots[0]).toEqual(job.slots[0]);expect(revised.request).toEqual(job.request);expect(revised.snapshot).toEqual(job.snapshot);expect(revised.videoCaseAmendment).toEqual(job.videoCaseAmendment);
 const v=revised.slots[1].videoSelection as Extract<NonNullable<typeof job.slots[1]['videoSelection']>,{version:2}>;
 expect(v.providerPortrait!.crop).toEqual({left:0,top:0,width:360,height:360});expect(v.providerPortrait!.verified).toBe(false);expect(v.portraitCropRevision!.previousPortrait).toEqual((job.slots[1].videoSelection as typeof v).providerPortrait);expect(v.portraitCropRevision!.previousAssessmentKeySha256).toBe(oldKey.split('/').at(-1)!.slice(0,-5));expect(storage.data.get(oldKey)).toEqual(oldRecord);expect(mocks.quota).not.toHaveBeenCalled();
 expect(await reviseBoundCaseCrop(job.id,2,request,storage)).toEqual(revised);
 await expect(reviseBoundCaseCrop(job.id,2,{...request,removePermille:440},storage)).rejects.toThrow('different crop revision');
 await expect(updateCreativePortfolio(job.id,c=>{(c.slots[1].videoSelection as typeof v).portraitCropRevision!.previousError='replaced';return c;},storage)).rejects.toThrow('immutable');
});
it('assesses only once in standard Luna, checkpoints then requires separate image intent',async()=>{
 const {job,storage,request}=await setup();await reviseBoundCaseCrop(job.id,2,request,storage);
 const provider=vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(quality)}]}]}));
 const passed=await assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider});expect(provider).toHaveBeenCalledTimes(1);
 const body=JSON.parse(provider.mock.calls[0][1]!.body as string);expect(body).toMatchObject({model:'gpt-6-luna',service_tier:'default',max_output_tokens:2048,reasoning:{effort:'low'}});
 expect(passed.slots[1].videoSelection?.version).toBe(2);const v=passed.slots[1].videoSelection as Extract<NonNullable<typeof passed.slots[1]['videoSelection']>,{version:2}>;
 expect(v.providerPortrait!.verified).toBe(true);expect(v.portraitCropRevision!.imageAuthorized).toBe(false);expect(passed.slots[1].status).toBe('PENDING');expect(passed.lease).toBeNull();
 await assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider});expect(provider).toHaveBeenCalledTimes(1);
 const authorized=await authorizeRevisedBoundCaseImage(job.id,2,storage);expect((authorized.slots[1].videoSelection as typeof v).portraitCropRevision!.imageAuthorized).toBe(true);expect(provider).toHaveBeenCalledTimes(1);
});
it.each(['unsafe','uncertain'])('stops %s after one assessment and blocks paid retry/image intent',async mode=>{
 const {job,storage,request}=await setup();await reviseBoundCaseCrop(job.id,2,request,storage);
 const provider=vi.fn<typeof fetch>();if(mode==='unsafe')provider.mockResolvedValue(Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({...quality,sourceOverlay:{version:2,status:'UNSAFE'}})}]}]}));else provider.mockRejectedValue(new Error('lost receipt'));
 const stopped=await assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider});expect(stopped.slots[1].status).toBe('RETRY_REQUIRED');expect(stopped.lease).toBeNull();expect(provider).toHaveBeenCalledTimes(1);
 if(mode==='uncertain')await expect(assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider})).rejects.toThrow('No repeat');else await assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider});
 expect(provider).toHaveBeenCalledTimes(1);expect(()=>retryPortfolioWork(stopped,2)).toThrow('repeated paid');await expect(authorizeRevisedBoundCaseImage(job.id,2,storage)).rejects.toThrow('passed');
});
it('refuses mismatched binding, concurrent job change, and an existing target image attempt',async()=>{
 const {job,storage,request,jobKey}=await setup();await expect(reviseBoundCaseCrop(job.id,2,{...request,timestampMs:request.timestampMs+2000},storage)).rejects.toThrow('differs');
 mocks.rebuild.mockImplementationOnce(async()=>{const current=JSON.parse(storage.data.get(jobKey)!.bytes.toString());current.updatedAtMs+=1;await storage.write(jobKey,Buffer.from(JSON.stringify(current)),storage.data.get(jobKey)!.etag);const v=job.slots[1].videoSelection!;const source=await sharp({create:{width:360,height:640,channels:3,background:'white'}}).png().toBuffer();return {frame:{buffer:source,frameSha256:hash(source),byteLength:source.length,timestampMs:request.timestampMs,sourceVideoMediaId:video.locator.sourceVideoMediaId,sourceVideoContentHash:video.locator.sourceVideoContentHash,sourceOverlay:v.selection!.sourceOverlays![0]},originalMetadata:{width:360,height:640}};});
 await expect(reviseBoundCaseCrop(job.id,2,request,storage)).rejects.toThrow('changed');
 await reserveImageAttempt({runId:`portfolio:${job.id}`,operationId:job.slots[1].creativeId,kind:'primary',fingerprint:'a'.repeat(64),budget:{purpose:'staging-smoke',primaryLimit:2,fallbackLimit:0}},storage);
 await expect(reviseBoundCaseCrop(job.id,2,request,storage)).rejects.toThrow('image attempts');expect((await readCreativePortfolio(job.id,storage))!.slots[1].status).toBe('RETRY_REQUIRED');
});

it.each(['complete','missing','running'])('reconciles an expired job lease with %s receipt without another provider attempt',async receipt=>{
 const {job,storage,request,jobKey}=await setup();const revised=await reviseBoundCaseCrop(job.id,2,request,storage);
 const v=revised.slots[1].videoSelection!;if(v.version!==2)throw new Error('fixture');
 v.portraitCropRevision!.assessmentAttempted=true;revised.lease={id:'expired-assessment',slotIndex:2,expiresAtMs:Date.now()-1};
 await storage.write(jobKey,Buffer.from(JSON.stringify(revised)),storage.data.get(jobKey)!.etag);
 const identity=providerPortraitIdentity(v.selection!,v.providerPortrait!,v.selectionModel);
 const key=`selections/candidates/sha256/${hash(JSON.stringify(identity))}.json`;
 if(receipt!=='missing')await storage.write(key,Buffer.from(JSON.stringify({version:1,identity,...(receipt==='complete'?{status:'COMPLETE',assessment:quality}:{status:'RUNNING',lease:{id:'expired-cache',expiresAtMs:Date.now()-1}})})),null);
 const provider=vi.fn<typeof fetch>();const reconciled=await assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider});
 expect(provider).not.toHaveBeenCalled();expect(mocks.quota).not.toHaveBeenCalled();expect(reconciled.lease).toBeNull();expect(reconciled.slots[0]).toEqual(job.slots[0]);
 expect(reconciled.slots[1].status).toBe(receipt==='complete'?'PENDING':'RETRY_REQUIRED');
 expect(reconciled.slots[1].videoSelection?.version===2 && reconciled.slots[1].videoSelection.providerPortrait!.verified).toBe(receipt==='complete');
});
it('concurrent assessment requests cannot purchase two calls',async()=>{
 const {job,storage,request}=await setup();await reviseBoundCaseCrop(job.id,2,request,storage);
 const provider=vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(quality)}]}]}));
 const outcomes=await Promise.allSettled([assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider}),assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider})]);
 expect(outcomes.some(outcome=>outcome.status==='fulfilled')).toBe(true);expect(provider).toHaveBeenCalledTimes(1);expect(mocks.quota).toHaveBeenCalledTimes(1);
 expect((await readCreativePortfolio(job.id,storage))!.slots[1].videoSelection?.version===2 && (await readCreativePortfolio(job.id,storage))!.lease).toBeNull();
});
it('recovers a durable completed cache after losing the job checkpoint with no repeat call',async()=>{
 const {job,storage,request}=await setup();await reviseBoundCaseCrop(job.id,2,request,storage);
 const write=storage.write.bind(storage);let interrupted=false;
 vi.spyOn(storage,'write').mockImplementation(async(key,bytes,etag)=>{
  if(key.startsWith('creative-portfolios/') && JSON.parse(bytes.toString()).slots?.[1]?.videoSelection?.providerPortrait?.verified && !interrupted){interrupted=true;throw new Error('lost job checkpoint');}
  return write(key,bytes,etag);
 });
 const provider=vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(quality)}]}]}));
 await expect(assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider})).rejects.toThrow('lost job checkpoint');
 const recovered=await assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider});expect(provider).toHaveBeenCalledTimes(1);
 expect(recovered.slots[1].videoSelection?.version===2 && recovered.slots[1].videoSelection.providerPortrait?.verified).toBe(true);expect(recovered.lease).toBeNull();
});
it('quota denial releases undispatched work without consuming its one assessment intent',async()=>{
 const {job,storage,request}=await setup();await reviseBoundCaseCrop(job.id,2,request,storage);mocks.quota.mockResolvedValue({allowed:false});const provider=vi.fn<typeof fetch>();
 await expect(assessRevisedBoundCaseCrop(job.id,2,'operator',storage,{request:provider})).rejects.toThrow('quota');
 const paused=(await readCreativePortfolio(job.id,storage))!;expect(paused.lease).toBeNull();expect(paused.slots[1].videoSelection?.version===2 && paused.slots[1].videoSelection.portraitCropRevision?.assessmentAttempted).toBe(false);expect(provider).not.toHaveBeenCalled();
});

it('ordinary advance is held before any provider or lease until separate image intent',async()=>{
 const {job,storage,request}=await setup();const revised=await reviseBoundCaseCrop(job.id,2,request,storage);
 const {advanceCreativePortfolio}=await import('@/lib/creatives/portfolio-execution');
 const result=await advanceCreativePortfolio(job.id,'operator','http://localhost/api/creatives/portfolios',storage);
 expect(result.status).toBe(409);expect(result.job).toEqual(revised);expect(mocks.quota).not.toHaveBeenCalled();expect(mocks.list).toHaveBeenCalledTimes(1);
});
