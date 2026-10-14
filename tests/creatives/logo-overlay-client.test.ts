import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LogoOverlayControl } from '@/components/creative-library/logo-overlay-control';
const hooks=vi.hoisted(()=>({values:[] as any[],cursor:0,logo:null as any,onSaved:vi.fn()}));
vi.mock('react',()=>({useState(initial:any){const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=typeof initial==='function'?initial():initial;return [hooks.values[i],(v:any)=>{hooks.values[i]=typeof v==='function'?v(hooks.values[i]):v;}];},useRef(initial:any){const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]={current:initial};return hooks.values[i];}}));
vi.mock('react/jsx-runtime',()=>({Fragment:'fragment',jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})}));
vi.mock('@/lib/creatives/brand-logo',()=>({readStoredBrandLogo:()=>hooks.logo}));
const id='creative_'+'a'.repeat(32),logoId='media_'+'b'.repeat(32);
const render=()=>{hooks.cursor=0;const tree=LogoOverlayControl({creative:{id,planning:{},generationProvenance:{}} as never,onSaved:hooks.onSaved});const nodes:any[]=[];const visit=(v:any)=>{if(Array.isArray(v))v.forEach(visit);else if(v?.props){nodes.push(v);visit(v.props.children);}};visit(tree);return nodes;};
const button=(label:string)=>render().find(n=>n.type==='button'&&n.props.children===label)!;
const waitForError=()=>vi.waitFor(()=>expect(render().some(n=>n.props.role==='alert')).toBe(true));
let session:Map<string,string>;
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.onSaved.mockClear();hooks.logo={mediaId:logoId,url:'https://different.host/api/media/files/'+logoId+'.png'};session=new Map();vi.stubGlobal('window',{sessionStorage:{getItem:(k:string)=>session.get(k)??null,setItem:(k:string,v:string)=>session.set(k,v),removeItem:(k:string)=>session.delete(k)}});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('uses only the saved same-origin logo and non-paid endpoint, saves separately and disables repeat',async()=>{
 const saved={id:'creative_'+'c'.repeat(32),image:{url:'/new.png'},identity:{parentCreativeId:id},generationProvenance:{logoOverlaySource:{mediaId:logoId},revision:{logoOverlay:{version:1,anchor:'top-left',outputSha256:'d'.repeat(64)}}}};
 const request=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({creative:saved},{status:201}));vi.stubGlobal('fetch',request);
 button('Add saved logo without AI').props.onClick();expect(render().find(n=>n.type==='img').props.src).toBe('/api/media/files/'+logoId+'.png');expect(request).not.toHaveBeenCalled();
 button('Save logo-only version').props.onClick();await vi.waitFor(()=>expect(hooks.onSaved).toHaveBeenCalledWith(saved));
 expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0][0]).toBe('/api/creatives/'+id+'/logo');expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({logoMediaId:logoId,anchor:'top-left'});expect(button('Save logo-only version').props.disabled).toBe(true);
});
it('retains unresolved intent through a refresh and repeats delivery only on an explicit click',async()=>{
 const requests:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url,init)=>{requests.push({url,key:init.headers['Idempotency-Key']});throw new Error('Lost acknowledgement');}));
 button('Add saved logo without AI').props.onClick();button('Save logo-only version').props.onClick();await waitForError();const first=requests[0].key;
 hooks.values=[];hooks.cursor=0;render();expect(requests).toHaveLength(1);button('Add saved logo without AI').props.onClick();button('Save logo-only version').props.onClick();await waitForError();expect(requests).toHaveLength(2);expect(requests[1].key).toBe(first);expect(hooks.onSaved).not.toHaveBeenCalled();
});
it.each([401,403])('pauses after %s denial and never automatically repeats',async status=>{
 const request=vi.fn(async()=>Response.json({error:'Sign in'},{status}));vi.stubGlobal('fetch',request);button('Add saved logo without AI').props.onClick();button('Save logo-only version').props.onClick();await waitForError();expect(button('Save logo-only version').props.disabled).toBe(true);expect(request).toHaveBeenCalledTimes(1);expect(hooks.onSaved).not.toHaveBeenCalled();
});
it('reports a missing saved original asset before any request',()=>{
 hooks.logo=null;vi.stubGlobal('fetch',vi.fn());button('Add saved logo without AI').props.onClick();expect(render().some(n=>n.props.role==='alert')).toBe(true);expect(button('Save logo-only version')).toBeUndefined();expect(fetch).not.toHaveBeenCalled();
});
