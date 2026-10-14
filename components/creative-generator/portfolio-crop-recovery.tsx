'use client';
import {useState} from 'react';
import type {portfolioPortraitDiagnostic} from '@/lib/creatives/portfolio-portrait-diagnostic';
import type {WorkspaceAccessObserver} from '@/lib/auth/workspace-access-client';
type Diagnostic=Awaited<ReturnType<typeof portfolioPortraitDiagnostic>>;
export function PortfolioCropRecovery({value,disabled,observeAccess,onStateChanged}:{value:Diagnostic;disabled:boolean;observeAccess:WorkspaceAccessObserver;onStateChanged?:()=>void}) {
  const [edge,setEdge]=useState(value.cropDecision?.status==='EDGE_CROP' ? value.cropDecision.edge : 'BOTTOM');
  const [removal,setRemoval]=useState(''),[preview,setPreview]=useState<Diagnostic|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  if(!value.recoveryEligible) return null;
  const request=async(prepare:boolean)=>{
    setBusy(true);setError('');
    try {
      const proposed=preview?.proposed;
      const response=prepare ? await fetch('/api/creatives/portfolios',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        id:value.portfolioId,action:'recover-bound-case-crop',slotIndex:value.slotIndex,revision:{
          frameId:value.frameIdentity.selectedFrameId,timestampMs:value.timestampMs,sourceVideoContentHash:value.sourceVideoContentHash,
          previousProviderPngSha256:value.portraitPin.providerPngSha256,sourcePngSha256:value.portraitPin.sourcePngSha256,
          revisedProviderPngSha256:proposed!.state.providerPngSha256,edge,removePermille:Number(removal)}})})
        : await fetch(`/api/creatives/portfolios/portrait-diagnostic?id=${encodeURIComponent(value.portfolioId)}&slotIndex=${value.slotIndex}&edge=${edge}&removePermille=${Number(removal)}`,{cache:'no-store'});
      observeAccess('portfolio-portrait-diagnostic',response.status);
      const next=await response.json(); if(!response.ok) throw new Error(next.error || 'Crop step unavailable. Reload saved progress.');
      if(prepare) onStateChanged?.(); else {setPreview(next);setConfirmed(false);}
    }catch(failure){setError(failure instanceof Error ? failure.message : 'Crop step unavailable.');}
    finally{setBusy(false);}
  };
  const invalid=!Number.isInteger(Number(removal))||Number(removal)<1||Number(removal)>450;
  const change=()=>{setPreview(null);setConfirmed(false);};
  return <section aria-label={`Creative ${value.slotIndex} crop recovery`}>
    <p>Propose one edge crop of this exact saved case/frame. Preview and preparation start no AI calls. A separate exact-PNG assessment must pass before image generation.</p>
    <label>Crop edge <select value={edge} disabled={disabled||busy} onChange={e=>{setEdge(e.target.value as typeof edge);change();}}>
      {['TOP','BOTTOM','LEFT','RIGHT'].map(item=><option key={item} value={item}>{item}</option>)}</select></label>
    <label>Crop removal permille <input type="number" min="1" max="450" value={removal} disabled={disabled||busy} onChange={e=>{setRemoval(e.target.value);change();}} /></label>
    <button type="button" disabled={disabled||busy||invalid} onClick={()=>void request(false)}>Preview revised crop without AI</button>
    {error ? <p role="alert">{error}</p> : null}
    {preview?.proposed ? <>
      <img src={preview.proposed.dataUrl} alt={`Unapproved revised portrait for Creative ${value.slotIndex}`} style={{maxWidth:'100%',height:'auto'}} />
      <p>Exact candidate: {preview.proposed.width} x {preview.proposed.height} pixels. Not approved for generation.</p>
      <label><input type="checkbox" checked={confirmed} disabled={disabled||busy} onChange={e=>setConfirmed(e.target.checked)} />I confirm this proposed crop keeps the useful face of this saved person and removes the source marks. It still needs its separate assessment.</label>
      <button type="button" disabled={disabled||busy||!confirmed} onClick={()=>void request(true)}>Prepare revised crop without AI</button>
    </> : preview?.proposalError ? <p role="alert">{preview.proposalError}</p> : null}
  </section>;
}
