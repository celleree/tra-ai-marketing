import { createRoot } from 'react-dom/client';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { parseWorkspaceSection } from '@/lib/workspace/navigation';
import '@/app/globals.css';
import '@/app/ui-sweep.css';
createRoot(document.getElementById('root')!).render(<CreativeGenerator initialSection={parseWorkspaceSection(new URLSearchParams(location.search).get('workspace'))} />);
