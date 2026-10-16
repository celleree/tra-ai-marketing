import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useCreativePortfolio } from '@/components/creative-generator/use-creative-portfolio';
import { PortfolioProgressPanel } from '@/components/creative-generator/portfolio-progress-panel';
function Recovery() {
  const portfolio = useCreativePortfolio();
  useEffect(() => { void portfolio.restoreSaved(); }, []);
  return <PortfolioProgressPanel portfolio={portfolio} />;
}
createRoot(document.getElementById('root')!).render(<Recovery />);
