import { AsyncLocalStorage } from 'node:async_hooks';
import { runDurableCheckpoint } from '@/lib/creatives/durable-checkpoint';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

type Scope = { runId: string; storage?: VideoIntelligenceStorage };
const scopes = new AsyncLocalStorage<Scope>();
export const withPaidPreparationScope = <T>(scope: Scope, work: () => Promise<T>) => scopes.run(scope, work);

/** A paid step is immutable within its submission. Unknown work is never automatically repeated. */
export function checkpointPaidPreparation<T>(step: string, input: unknown, work: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  return scope ? runDurableCheckpoint(scope.runId, `paid:${step}`, input, work, { storage: scope.storage }) : work();
}
