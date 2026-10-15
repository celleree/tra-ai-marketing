import { createRoot } from 'react-dom/client';
import { CreativeGenerator } from '@/components/creative-generator/creative-generator';
import { PortfolioCaseAmendment } from '@/components/creative-generator/portfolio-case-amendment';

// Real Create owner and components; all API work is intercepted by the offline browser runner.
const query = new URL(window.location.href).searchParams;
createRoot(document.getElementById('root')!).render(query.has('caseAmendment')
  ? <PortfolioCaseAmendment id={`portfolio_${'4'.repeat(32)}`} observeAccess={() => {}} onClose={() => {}} onSaved={() => {}} />
  : <CreativeGenerator acceptancePreview={query.get('acceptancePreview') === '1'} />);
