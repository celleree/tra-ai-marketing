import { createRoot } from 'react-dom/client';
import { RevisionControls } from '@/components/creative-library/revision-controls';
const creative={id:'creative_'+ 'a'.repeat(32),identity:{},planning:{},generationProvenance:{requestedSources:[],attachedSource:null},placement:'PORTRAIT_4_5',format:'direct-response'};
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:600,padding:12}}><h1>Accepted creative</h1><p>Original supplied image and claim remain saved.</p><RevisionControls creative={creative as never} onSaved={()=>{}} showOtherOperations={false}/></main>);
