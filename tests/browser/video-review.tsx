import { createRoot } from 'react-dom/client';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';

// Real Create owner and components; all API work is intercepted by the offline browser runner.
createRoot(document.getElementById('root')!).render(<CreativeGenerator />);
