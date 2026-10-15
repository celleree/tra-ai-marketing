import { wanRoute } from '@/lib/video-generation/wan/route';
import { getWanService } from '@/lib/video-generation/wan/service';
import { createVideoResponse } from '@/lib/media/video-response';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return wanRoute(async owner => createVideoResponse(await getWanService().output(owner, (await context.params).id), request));
}
