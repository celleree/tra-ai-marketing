import { createHash } from 'node:crypto';
import { buildCreativeCompanyContext, formatCreativeCompanyContext, normalizeRuntimeCompanyProfile } from '@/lib/company/creative-context';
import { resolveCreativeAdCopy } from '@/lib/creatives/copy-contract';
import { isSafeCreativeId, listCreatives } from '@/lib/creatives/storage';
import { parseCopilotContextSnapshot, type CopilotContextSnapshot } from '@/lib/copilot/records';

export class CopilotContextError extends Error {
  constructor(public readonly code: 'approval_required' | 'invalid_input' | 'creative_unavailable' | 'invalid_evidence') {
    super(`Copilot context: ${code}`); this.name = 'CopilotContextError';
  }
}

/** Authenticated caller must confirm approval of the effective browser company snapshot before use. */
export async function buildSavedCopilotContext(
  creativeId: unknown, companyProfile: unknown, companyContextApproved: unknown,
  dependencies: { listCreatives?: typeof listCreatives } = {},
): Promise<CopilotContextSnapshot> {
  if (companyContextApproved !== true) throw new CopilotContextError('approval_required');
  const profile = normalizeRuntimeCompanyProfile(companyProfile);
  if (typeof creativeId !== 'string' || !isSafeCreativeId(creativeId)
    || (companyProfile !== undefined && companyProfile !== null && !profile)) throw new CopilotContextError('invalid_input');
  const creative = (await (dependencies.listCreatives ?? listCreatives)()).find(item => item.id === creativeId);
  if (!creative || !creative.identity) throw new CopilotContextError('creative_unavailable');
  const approvedText = formatCreativeCompanyContext(buildCreativeCompanyContext(profile));
  const strategy = creative.planning?.strategy;
  const context = parseCopilotContextSnapshot({
    company: { reference: `company:sha256:${createHash('sha256').update(approvedText).digest('hex')}`, approvedText },
    creatives: [{ creativeId: creative.id, identity: creative.identity,
      // The creative ID binds the artifact; unrelated source IDs have no supplied approved evidence text.
      sourceReferences: [], evidence: { adCopy: resolveCreativeAdCopy(creative), imageCopy: creative.imageCopy ?? null,
        category: creative.category, format: creative.format ?? null, placement: creative.placement ?? null,
        strategy: strategy ? { hook: strategy.hook, proposition: strategy.conceptDetails?.proposition ?? null,
          visualDirection: strategy.visualDirection, soWhat: strategy.soWhat } : null,
        humanReviewStatus: creative.humanReview?.status ?? null } }], performance: 'unknown',
  });
  if (!context) throw new CopilotContextError('invalid_evidence');
  return context;
}
