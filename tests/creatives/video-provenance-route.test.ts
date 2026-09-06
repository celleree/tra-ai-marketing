import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({save:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/creatives/storage',()=>({isSafeCreativeId:(id:string)=>/^creative_[a-f0-9]{32}$/.test(id),saveCreativeBatch:mocks.save,listCreatives:vi.fn()}));
vi.mock('@/lib/media/local-storage',()=>({getMediaStorage:()=>({readImageById:mocks.read})}));
vi.mock('@/lib/creatives/attribution',()=>({getCreativeAttribution:vi.fn()}));
import {POST} from '@/app/api/creatives/route';
const id=`media_${'1'.repeat(32)}`;
const selection={libraryId:`video-library:${'2'.repeat(64)}`,sourceVideoMediaId:`media_${'3'.repeat(32)}`,sourceVideoContentHash:'4'.repeat(64),
  frames:[{frameIndex:0,libraryFrameId:`video-frame:${'5'.repeat(64)}`,candidateFrameSha256:'6'.repeat(64),timestampMs:500,approvedPngSha256:'7'.repeat(64)}]};
const creative={id:`creative_${'8'.repeat(32)}`,image:{id,fileName:`${id}.png`,originalName:'generated.png',mimeType:'image/png',size:100,url:'/ignored'},
  category:'customer-problems',copy:{headline:'Options',primaryText:'Talk to TRA',description:''},videoFrameSelection:selection};
const request=(item:unknown)=>new Request('http://localhost/api/creatives',{method:'POST',body:JSON.stringify({creatives:[item]})});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('NODE_ENV','test');mocks.read.mockResolvedValue({fileName:`${id}.png`,mimeType:'image/png'});mocks.save.mockImplementation(async items=>items);});
afterEach(()=>vi.unstubAllEnvs());
it('retains complete selected-video provenance at the save API boundary',async()=>{
 const response=await POST(request(creative));expect(response.status).toBe(201);
 expect(mocks.save).toHaveBeenCalledWith([expect.objectContaining({videoFrameSelection:selection})]);
 expect((await response.json()).items[0].videoFrameSelection).toEqual(selection);
});
it('rejects incomplete provenance before reading images or saving records',async()=>{
 const response=await POST(request({...creative,videoFrameSelection:{...selection,frames:[]}}));
 expect(response.status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();
});
