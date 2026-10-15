import { readWebhookBytes, verifyWanWebhook } from '@/lib/video-generation/wan/webhook';
import { getWanService } from '@/lib/video-generation/wan/service';
import { WanError } from '@/lib/video-generation/wan/types';
export const runtime = 'nodejs';
export const maxDuration = 300;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
/** Public health challenge contains no private state; paid admission probes it without operator cookies. */
export async function GET(request: Request) {
  const challenge = new URL(request.url).searchParams.get('challenge');
  if (!challenge || !/^[a-f0-9-]{36}$/.test(challenge)) return response({ error: 'Invalid callback challenge.' }, 400);
  return response({ version: 1, challenge, deployment: process.env.VERCEL_URL });
}
/** Provider-authenticated endpoint: never depends on an open browser or Clerk session. */
export async function POST(request: Request) {
  try {
    const bytes = await readWebhookBytes(request), signed = await verifyWanWebhook(request.headers, bytes), body = JSON.parse(bytes.toString());
    if (body.request_id !== signed.requestId || !['OK', 'ERROR'].includes(body.status)) throw new WanError('Invalid completion payload.', 400);
    const query = new URL(request.url).searchParams;
    await getWanService().completeWebhook(query.get('operator') ?? '', query.get('job') ?? '', signed.requestId, signed.userId, body.status);
    return response({ captured: true });
  } catch (error) { return response({ error: error instanceof WanError ? error.message : 'Completion capture failed; retry notification.' }, error instanceof WanError ? error.status : 503); }
}
