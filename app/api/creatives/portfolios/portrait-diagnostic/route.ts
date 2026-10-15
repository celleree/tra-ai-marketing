import { parseSourceOverlayDecision } from '@/lib/video/source-overlay-contract';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { readCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { isPortfolioId } from '@/lib/creatives/portfolio-job-parser';
import { portfolioPortraitDiagnostic } from '@/lib/creatives/portfolio-portrait-diagnostic';

export const runtime = 'nodejs';
export const maxDuration = 300;
const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
/** Authenticated GET only. No job/cache/ledger mutation or provider dispatch. */
export async function GET(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  const params = new URL(request.url).searchParams, id = params.get('id') ?? '', slotIndex = Number(params.get('slotIndex'));
  if (!isPortfolioId(id) || !Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > 36) return json({ error: 'Supply the saved portfolio and creative number.' }, 400);
  try {
    const job = await readCreativePortfolio(id);
    if (!job) return json({ error: 'Saved portfolio was not found.' }, 404);
    const edge=params.get('edge'), removal=params.get('removePermille');
    const proposal=edge!==null || removal!==null ? parseSourceOverlayDecision({version:2,status:'EDGE_CROP',edge,removePermille:Number(removal),overlayDepthPermille:Number(removal)}) : undefined;
    if ((edge!==null || removal!==null) && (!proposal || proposal.status!=='EDGE_CROP')) return json({error:'Supply one crop edge and 1 to 450 permille removal.'},400);
    return json(await portfolioPortraitDiagnostic(job, slotIndex, undefined, proposal ?? undefined));
  } catch { return json({ error: 'Portrait diagnostic is unavailable. Reload saved progress; no generation or retry was started.' }, 409); }
}
