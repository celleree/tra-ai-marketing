import type { PortfolioAudit } from '@/lib/creatives/portfolio-audit';

export const portfolioAudit = (conceptCount = 2): PortfolioAudit => ({
  version: 1, model: 'gpt-6-astra', conceptCount, executionNotes: 'Consider broader environments when useful; no fixed human quota.',
  groups: Array.from({ length: conceptCount }, (_, index) => ({ conceptIndexes: [index + 1],
    proposition: `Grounded proposition ${index + 1}`, distinction: `Different reason to act ${index + 1}` })),
});
