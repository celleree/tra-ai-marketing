import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import type { CreativePortfolioSnapshot } from '@/lib/creatives/portfolio-snapshot';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { portfolioAudit } from './portfolio-audit';

export class MemoryPortfolioStorage implements VideoIntelligenceStorage {
  data = new Map<string, { bytes: Buffer; etag: string }>();
  async read(key: string) { return this.data.get(key) ?? null; }
  async write(key: string, bytes: Buffer, expected: string | null) {
    const current = this.data.get(key);
    if ((current?.etag ?? null) !== expected) return false;
    this.data.set(key, { bytes, etag: String(Number(current?.etag ?? 0) + 1) }); return true;
  }
}
export const portfolioRequest = (count = 2) => ({ context: 'Frozen Company context', sourceAssets: [], placement: 'SQUARE_1_1' as const, variationCount: count });
export const portfolioSnapshot = (job: CreativePortfolioJob): CreativePortfolioSnapshot => ({
  version: 1, request: job.request, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [], videoFrames: [],
  batchPlan: { plannerModel: 'gpt-6-astra', reasoningEffort: 'medium', portfolioAudit: portfolioAudit(job.slots.length),
    creatives: job.slots.map(({ index }) => ({ index, format: 'direct-response', selectionReason: 'Useful distinction',
      copy: { headline: `Headline ${index}`, primaryText: 'Explore options', description: '' },
      adCopy: { headline: `Headline ${index}`, primaryText: 'Explore options', description: '' },
      imageCopy: { headline: `Headline ${index}`, cta: 'Talk to TRA' },
      strategy: { category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer',
        painPoint: 'Uncertainty', desiredOutcome: 'Understanding', emotion: 'Relief', hook: 'Explore', cta: 'Talk to TRA', offer: null,
        soWhat: { surfaceMessage: `Distinct proposition ${index}`, functionalConsequence: 'Compare options', meaningfulOutcome: 'Informed decision' },
        execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'illustrative', textDensity: 'low',
          ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'Simple graphic' } })) },
});
