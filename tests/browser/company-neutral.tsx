import { createRoot } from 'react-dom/client';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { ReferenceLibrary } from '@/components/reference-library/reference-library';
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('references')
  ? <ReferenceLibrary /> : <CreativeGenerator />);
