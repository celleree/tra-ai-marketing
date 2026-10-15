import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { isPortfolioId } from '@/lib/creatives/portfolio-job-parser';
import { readCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { caseAmendmentOptions, proposeCaseAmendment, type VideoCasePair } from '@/lib/creatives/portfolio-case-amendment';
import { applyCaseAmendment } from '@/lib/creatives/portfolio-case-amendment-storage';
import { record, ReviewSelectionError } from '@/lib/video/review-selection';

export const runtime = 'nodejs';
const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const failure = (error: unknown) => error instanceof ReviewSelectionError ? json({ error: error.message }, error.status)
  : json({ error: 'Case amendment could not be saved or loaded. Reload saved progress; no generation was started.' }, 409);

export async function GET(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id || !isPortfolioId(id)) return json({ error: 'Supply a saved portfolio ID.' }, 400);
    const job = await readCreativePortfolio(id!);
    if (!job) return json({ error: 'Creative portfolio was not found.' }, 404);
    return json(job.videoCaseAmendment ? { applied: true, amendment: job.videoCaseAmendment } : caseAmendmentOptions(job));
  } catch (error) { return failure(error); }
}

async function write(request: Request, apply: boolean) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const text = await request.text();
    if (text.length > 64 * 1024) return json({ error: 'Case amendment request is too large.' }, 400);
    const body: unknown = JSON.parse(text);
    if (!record(body) || Object.keys(body).length !== 2 || typeof body.id !== 'string' || !isPortfolioId(body.id)
      || !(apply ? 'amendment' in body : Array.isArray(body.pairs))) return json({ error: 'Supply the saved portfolio and explicit case choices.' }, 400);
    if (apply) {
      const job = await applyCaseAmendment(String(body.id), body.amendment);
      return json({ applied: true, amendment: job.videoCaseAmendment });
    }
    const job = await readCreativePortfolio(String(body.id));
    if (!job) return json({ error: 'Creative portfolio was not found.' }, 404);
    return json(proposeCaseAmendment(job, body.pairs as VideoCasePair[]));
  } catch (error) { return error instanceof SyntaxError ? json({ error: 'Invalid JSON body.' }, 400) : failure(error); }
}
/** Read-only proposal. PATCH is a separate explicit save and never advances the portfolio. */
export const POST = (request: Request) => write(request, false);
export const PATCH = (request: Request) => write(request, true);
