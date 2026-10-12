import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import '@/app/ui-sweep.css';
import { CreativeLibrary } from '@/components/creative-library/creative-library';
import { buildCreativeCompanyContext, formatCreativeCompanyContext } from '@/lib/company/creative-context';

Object.assign(window, { fixtureCompanyText: (profile: Parameters<typeof buildCreativeCompanyContext>[0]) => formatCreativeCompanyContext(buildCreativeCompanyContext(profile)) });
createRoot(document.getElementById('root')!).render(<CreativeLibrary />);
