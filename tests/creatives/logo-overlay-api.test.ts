import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { POST } from '@/app/api/creatives/[creativeId]/logo/route';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { parseCreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import type { CreativeRecord } from '@/lib/creatives/generated';
let execution = new MemoryPortfolioStorage();
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), save: vi.fn(), readImage: vi.fn(), saveImage: vi.fn() }));
vi.mock('@/lib/video/intelligence-storage', () => ({ getVideoIntelligenceStorage: () => execution }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/creatives/storage', async original => ({ ...await original<typeof import('@/lib/creatives/storage')>(), listCreatives: mocks.list, saveCreativeBatch: mocks.save }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({ readImageById: mocks.readImage, saveImage: mocks.saveImage }) }));
const parentId = 'creative_' + 'a'.repeat(32), mediaId = 'media_' + 'b'.repeat(32), logoId = 'media_' + 'c'.repeat(32);
const key = '11111111-1111-4111-8111-111111111111';
const request = (body: unknown = { logoMediaId: logoId, anchor: 'top-left' }, id = key) => new Request('https://preview.test/api/creatives/'+parentId+'/logo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id }, body: JSON.stringify(body) });
const context = { params: Promise.resolve({ creativeId: parentId }) };
const hash = (b: Buffer|string) => createHash('sha256').update(b).digest('hex');
let parent: CreativeRecord, records: CreativeRecord[], canvas: Buffer, logo: Buffer, output: Buffer;
beforeEach(async () => {
 vi.resetAllMocks();execution=new MemoryPortfolioStorage();
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No provider request allowed');}));
 const strategy=portfolioSnapshot(newCreativePortfolio(portfolioRequest())).batchPlan.creatives[0].strategy;
 canvas=await sharp({create:{width:1024,height:1280,channels:3,background:'#153b5f'}}).png().toBuffer();
 logo=await sharp({create:{width:180,height:80,channels:4,background:'#017ace'}}).png().toBuffer();
 parent={id:parentId,createdAt:'2026-10-14T10:00:00Z',category:'customer-problems',format:'direct-response',placement:'PORTRAIT_4_5',
  image:{id:mediaId,fileName:mediaId+'.png',originalName:'accepted.png',mimeType:'image/png',size:canvas.length,url:'/api/media/files/'+mediaId+'.png'},
  copy:{headline:'One supplied experience',primaryText:'Source-bound quote remains unchanged',description:''},imageCopy:{headline:'One supplied experience',shortSupport:'Same supplied quote',cta:'Learn about the process',disclosure:'Individual result. Results vary.'},
  planning:{strategy,model:'saved-planner',reasoningEffort:'medium',selectionReason:'Accepted case'},identity:buildCreativeIdentity({creativeId:parentId,operation:'GENERATE',strategy}),
  generationProvenance:{version:1,imageGeneration:{prompt:'Original render',model:'saved-image-model'},requestedSources:[],attachedSource:null,analysisSources:[]},
  humanReview:{status:'APPROVED'} as never,lifecycle:{status:'ACTIVE'} as never};
 records=[parent];mocks.access.mockResolvedValue({allowed:true,userId:'operator'});mocks.list.mockImplementation(async()=>records);
 mocks.readImage.mockImplementation(async id=>({buffer:id===mediaId?canvas:logo,fileName:id+'.png',mimeType:'image/png'}));
 mocks.saveImage.mockImplementation(async file=>{output=Buffer.from(await file.arrayBuffer());return {id:'media_'+'d'.repeat(32),fileName:'media_'+'d'.repeat(32)+'.png',mimeType:'image/png',originalName:'logo-version.png',size:output.length,url:'/new.png'};});
 mocks.save.mockImplementation(async batch=>{records.push(...batch);return batch;});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('saves a separate deterministic version with exact artwork hashes and untouched copy/source/parent',async()=>{
 const original=structuredClone(parent);const response=await POST(request(),context);expect(response.status).toBe(201);expect(response.headers.get('Cache-Control')).toBe('private, no-store');
 const saved=(await response.json()).creative as CreativeRecord;
 expect(saved.id).not.toBe(parent.id);expect(saved.identity).toMatchObject({operation:'EDIT',parentCreativeId:parent.id,conceptId:parent.id,fingerprint:parent.identity!.fingerprint});
 expect(saved.copy).toEqual(parent.copy);expect(saved.imageCopy).toEqual(parent.imageCopy);expect(saved.generationProvenance!.requestedSources).toEqual(parent.generationProvenance!.requestedSources);expect(parent).toEqual(original);
 expect(saved).not.toHaveProperty('humanReview');expect(saved).not.toHaveProperty('lifecycle');
 expect(saved.generationProvenance!.revision).toMatchObject({canvasMediaId:mediaId,canvasSha256:hash(canvas),logoOverlay:{version:1,anchor:'top-left',outputSha256:hash(output)}});
 expect(saved.generationProvenance!.logoOverlaySource).toEqual({mediaId:logoId,sha256:hash(logo)});expect(parseCreativeGenerationProvenance(saved.generationProvenance)).toEqual(saved.generationProvenance);expect(fetch).not.toHaveBeenCalled();
 const before=await sharp(canvas).ensureAlpha().raw().toBuffer(),after=await sharp(output).ensureAlpha().raw().toBuffer();
 // Compare every decoded pixel against the canonical overlay rectangle.
 const {resolveCreativeBrandLogoGeometry}=await import('@/lib/creatives/brand-logo.server');const {panel}=await resolveCreativeBrandLogoGeometry(logo,'PORTRAIT_4_5','top-left');
 let changedOutside=0,changedInside=0;
 for(let y=0;y<1280;y++)for(let x=0;x<1024;x++){let changed=false;for(let c=0;c<4;c++)if(before[(y*1024+x)*4+c]!==after[(y*1024+x)*4+c])changed=true;if(changed){if(x>=panel.left&&x<panel.left+panel.width&&y>=panel.top&&y<panel.top+panel.height)changedInside++;else changedOutside++;}}
 expect(changedOutside).toBe(0);expect(changedInside).toBeGreaterThan(0);expect((await sharp(output).metadata())).toMatchObject({width:1024,height:1280});
});
it('repeated and concurrent delivery create only one version/media',async()=>{
 const results=await Promise.all([POST(request(),context),POST(request(),context)]);expect(results.some(r=>r.status===201)).toBe(true);expect(results.every(r=>[201,202].includes(r.status))).toBe(true);
 const first=records[1];const repeated=await POST(request(),context);expect((await repeated.json()).creative.id).toBe(first.id);expect(mocks.saveImage).toHaveBeenCalledTimes(1);expect(mocks.save).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
 expect((await POST(request({logoMediaId:logoId,anchor:'bottom-right'}),context)).status).toBe(409);expect(mocks.saveImage).toHaveBeenCalledTimes(1);
});
it('reconciles a saved child after losing the final checkpoint without upload/save duplication',async()=>{
 const write=execution.write.bind(execution);let lost=false;const step=hash('logo-version');
 vi.spyOn(execution,'write').mockImplementation(async(path,bytes,etag)=>{if(path.endsWith('/'+step+'.json') && JSON.parse(bytes.toString()).status==='COMPLETE'&&!lost){lost=true;throw new Error('lost checkpoint');}return write(path,bytes,etag);});
 expect((await POST(request(),context)).status).toBe(409);expect((await POST(request(),context)).status).toBe(201);expect(mocks.saveImage).toHaveBeenCalledTimes(1);expect(mocks.save).toHaveBeenCalledTimes(1);
});
it.each([401,403])('enforces %s before private reads or writes',async status=>{
 mocks.access.mockResolvedValue({allowed:false,status,error:'Denied'});expect((await POST(request(),context)).status).toBe(status);expect(mocks.list).not.toHaveBeenCalled();expect(mocks.readImage).not.toHaveBeenCalled();expect(mocks.saveImage).not.toHaveBeenCalled();
});
it.each([null,{logoMediaId:'https://foreign/image.png',anchor:'top-left'},{logoMediaId:logoId,anchor:'center'},{logoMediaId:logoId,anchor:'top-left',instruction:'regenerate'}])('rejects invalid logo intent %j without reading data',async body=>{
 expect((await POST(request(body),context)).status).toBe(400);expect(mocks.list).not.toHaveBeenCalled();
});
it('preserves video/source/Proof association without reanalysis and rejects an existing overlay',async()=>{
 const sourceId='media_'+'e'.repeat(32),sha='f'.repeat(64);
 parent.generationProvenance!.requestedSources=[{role:'TRA_VIDEO',mediaId:sourceId,sha256:sha}];
 parent.generationProvenance!.attachedSource={type:'TRA_VIDEO_FRAMES',mediaId:sourceId,sourceSha256:sha,selectionMode:'USER_SELECTED',frames:[{timestampMs:23333,approvedPngSha256:sha,providerPngSha256:sha,sourceOverlay:{version:2,status:'CLEAN'},crop:null}]};
 parent.videoFrameSelection={sourceVideoMediaId:sourceId,sourceVideoContentHash:sha,libraryId:'video-library:'+sha,frames:[{frameIndex:0,timestampMs:23333,approvedPngSha256:sha,libraryFrameId:'video-frame:'+sha,candidateFrameSha256:sha}]};
 parent.proofProvenance={version:1,type:'review',proofId:'proof_'+'9'.repeat(32),proofUpdatedAt:'2026-10-14T10:00:00Z',selectedText:'Source-bound quote remains unchanged',attribution:'Supplied account'};
 const saved=(await (await POST(request(),context)).json()).creative;expect(saved.videoFrameSelection).toEqual(parent.videoFrameSelection);expect(saved.proofProvenance).toEqual(parent.proofProvenance);expect(saved.generationProvenance.attachedSource).toEqual(parent.generationProvenance!.attachedSource);expect(fetch).not.toHaveBeenCalled();
 parent.generationProvenance!.logoOverlaySource={mediaId:logoId,sha256:hash(logo)};expect((await POST(request(undefined,'22222222-2222-4222-8222-222222222222'),context)).status).toBe(409);
});
it('sanitizes missing/corrupt asset failures and never mutates the accepted parent',async()=>{
 const original=structuredClone(parent);mocks.readImage.mockResolvedValue(null);expect((await POST(request(),context)).status).toBe(409);expect(mocks.saveImage).not.toHaveBeenCalled();expect(parent).toEqual(original);
 mocks.readImage.mockRejectedValue(new Error('private/path?signature=secret'));const failure=await POST(request(undefined,'22222222-2222-4222-8222-222222222222'),context);expect(await failure.text()).not.toContain('signature');expect(mocks.save).not.toHaveBeenCalled();
});

it('strictly validates the deterministic revision stamp without accepting approval or model extras',async()=>{
 const saved=(await (await POST(request(),context)).json()).creative;const provenance=saved.generationProvenance;
 for(const invalid of [{...provenance.revision.logoOverlay,anchor:'center'},{...provenance.revision.logoOverlay,outputSha256:'bad'},{...provenance.revision.logoOverlay,approved:true}])expect(parseCreativeGenerationProvenance({...provenance,revision:{...provenance.revision,logoOverlay:invalid}})).toBeNull();
 const {logoOverlaySource:removed,...withoutSource}=provenance;expect(parseCreativeGenerationProvenance(withoutSource)).toBeNull();
});
