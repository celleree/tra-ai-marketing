import { getOperatorAccess } from '@/lib/auth/server-access';
import { WanError } from './types';
const privateResponse = (response: Response) => { response.headers.set('Cache-Control', 'private, no-store'); return response; };
export async function wanRoute(operation: (owner: string) => Promise<Response>) {
  const access = await getOperatorAccess();
  if (!access.allowed) return privateResponse(Response.json({ error: access.error }, { status: access.status }));
  try { return privateResponse(await operation(access.userId)); }
  catch (error) { return privateResponse(Response.json({ error: error instanceof WanError ? error.message : 'AI Videos could not complete this operation. Refresh to check the saved job before retrying.' }, { status: error instanceof WanError ? error.status : 500 })); }
}
export async function wanBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 12_000) throw new WanError('Request too large.');
  let value; try { value = JSON.parse(text); } catch { throw new WanError('Invalid request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WanError('Invalid request.');
  return value;
}
