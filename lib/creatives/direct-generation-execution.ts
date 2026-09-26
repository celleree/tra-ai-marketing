import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { listCreatives } from '@/lib/creatives/storage';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import { runDurableCheckpoint } from '@/lib/creatives/durable-checkpoint';
import { withPaidPreparationScope } from '@/lib/creatives/preparation-checkpoint';
import { prepareCreativeGeneration, type PreparedCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { snapshotCreativePortfolio, restoreCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import { imageAttemptBudget, withImageAttemptScope } from '@/lib/creatives/image-attempt-execution';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import { getVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

/** The existing single-request pipeline, with each paid step retained under one submission. */
export async function directGenerationExecution(runId: string, operatorId: string, request: ValidGenerateCreativeRequest,
  requestUrl: string, storage = getVideoIntelligenceStorage()) {
  for (const group of ['CREATIVE_GENERATION', 'CREATIVE_PLANNING'] as const) {
    await runDurableCheckpoint(runId, `quota:${group}`, request, async () => {
      const denied = await requireOperatorQuota(operatorId, group, request.variationCount);
      if (denied) throw denied;
      return true;
    }, { storage, safeToResume: true });
  }
  let prepared: PreparedCreativeGeneration | undefined;
  const snapshot = await runDurableCheckpoint(runId, 'prepared', request, async () => {
    prepared = await withPaidPreparationScope({ runId, storage }, () => prepareCreativeGeneration(request, requestUrl));
    return snapshotCreativePortfolio(prepared);
  }, { storage, safeToResume: true });
  // Replays hydrate current approved pixels and reject changed source/selection identities.
  const context = prepared ?? await restoreCreativePortfolio(snapshot);
  return { plan: context.batchPlan.creatives, render: (item: PlannedCreativeConcept) => {
    const creativeId = 'creative_' + createHash('sha256').update(`${runId}:${item.index}`).digest('hex').slice(0, 32);
    return runDurableCheckpoint(runId, `render:${item.index}`, { snapshot, item }, async assertCurrentWork => {
      const existing = (await listCreatives()).find(record => record.id === creativeId);
      if (existing) {
        const identity = buildCreativeIdentity({ creativeId, operation: 'GENERATE', strategy: item.strategy });
        if (!isDeepStrictEqual(existing.identity, identity) || !isDeepStrictEqual(existing.copy, item.copy)
          || existing.format !== item.format || existing.placement !== request.placement) {
          throw new Error('Saved creative does not match its reserved generation intent.');
        }
        return { ...existing, index: item.index, format: item.format,
          finalization: { status: 'SAVED', createdAt: existing.createdAt } } satisfies GeneratedCreative;
      }
      return withImageAttemptScope({ runId, operationId: creativeId, budget: imageAttemptBudget(request.variationCount), storage },
        () => renderPlannedCreative(item, context, { creativeId, assertCurrentWork }));
    }, { storage, safeToResume: true });
  } };
}
