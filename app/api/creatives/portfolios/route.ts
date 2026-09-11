import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';
import { assertGenerationAvailable, CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { isPortfolioId } from '@/lib/creatives/portfolio-job-parser';
import { retryPortfolioWork, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { portfolioProgress } from '@/lib/creatives/portfolio-progress';
import { readPortfolioCreatives } from '@/lib/creatives/portfolio-results';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';

export const runtime = 'nodejs';
export const maxDuration = 300;
const json = (body: object, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
const result = async (job: CreativePortfolioJob, status = 200, error?: string, retryAfterSeconds?: number) =>
  json({ job: portfolioProgress(job), creatives: await readPortfolioCreatives(job), ...(error ? { error } : {}) },
    status, retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {});
const failure = (error: unknown) => {
  if (error instanceof SyntaxError) return json({ error: 'Invalid JSON body.' }, 400);
  if (error instanceof CreativeGenerationPreparationError) return json({ error: error.message }, error.status);
  console.error('Creative portfolio request failed', error);
  return json({ error: 'Creative portfolio request failed. Reload its saved progress before continuing.' }, 500);
};

export async function GET(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!isPortfolioId(id)) return json({ error: 'Invalid portfolio ID.' }, 400);
    const job = await readCreativePortfolio(id);
    return job ? await result(job) : json({ error: 'Portfolio not found.' }, 404);
  } catch (error) { return failure(error); }
}

/** Creation persists identities only. No quota reservation, planning or paid rendering. */
export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const parsed = validateGenerateCreativeRequest(await request.json(), MAX_PORTFOLIO_CREATIVES);
    if (!parsed.success) return json({ error: parsed.error }, 400);
    assertGenerationAvailable(parsed.data);
    return await result(await createCreativePortfolio(parsed.data), 201);
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string' || !isPortfolioId(body.id)
      || !['advance', 'retry'].includes(body.action)
      || (body.action === 'advance' && body.slotIndex !== undefined)
      || (body.action === 'retry' && body.slotIndex !== null
        && (!Number.isInteger(body.slotIndex) || body.slotIndex < 1 || body.slotIndex > MAX_PORTFOLIO_CREATIVES))) {
      return json({ error: 'Invalid portfolio action.' }, 400);
    }
    const job = await readCreativePortfolio(body.id);
    if (!job) return json({ error: 'Portfolio not found.' }, 404);
    if (body.action === 'retry') {
      const retryable = body.slotIndex === null ? !job.snapshot && job.planningError
        : job.snapshot && job.slots.some(slot => slot.index === body.slotIndex && slot.status === 'RETRY_REQUIRED');
      if (job.lease || !retryable) return json({ error: 'This work cannot be retried in its current state. Reload its progress.' }, 409);
      return await result(await updateCreativePortfolio(body.id, current => retryPortfolioWork(current, body.slotIndex)));
    }
    const step = await advanceCreativePortfolio(body.id, access.userId, request.url);
    return await result(step.job, step.status, step.error, step.retryAfterSeconds);
  } catch (error) { return failure(error); }
}
