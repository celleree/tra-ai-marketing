import { wanBody, wanRoute } from '@/lib/video-generation/wan/route';
import { getWanService } from '@/lib/video-generation/wan/service';
import { WanError } from '@/lib/video-generation/wan/types';
export const runtime = 'nodejs';
export const maxDuration = 120;
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  return wanRoute(async owner => {
    const { id } = await context.params; const body = await wanBody(request); const service = getWanService();
    if (body.action !== 'launch' && body.action !== 'refresh') throw new WanError('Choose launch or refresh.');
    return Response.json({ job: body.action === 'launch' ? await service.launch(owner, id, body) : await service.refresh(owner, id) });
  });
}
