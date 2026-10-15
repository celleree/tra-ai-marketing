import { wanBody, wanRoute } from '@/lib/video-generation/wan/route';
import { getWanService } from '@/lib/video-generation/wan/service';
import { wanAccessEnabled, wanPaidEnabled } from '@/lib/video-generation/wan/types';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET() {
  return wanRoute(async owner => Response.json({ accessEnabled: wanAccessEnabled(), paidEnabled: wanPaidEnabled(),
    jobs: wanAccessEnabled() ? await getWanService().list(owner) : [] }));
}
export async function POST(request: Request) {
  return wanRoute(async owner => Response.json({ job: await getWanService().quote(owner, await wanBody(request)) }));
}
