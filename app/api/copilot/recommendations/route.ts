import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { buildSavedCopilotContext, CopilotContextError } from '@/lib/copilot/context';
import { CLAUDE_COPILOT_MODEL, ClaudeCopilotError, requestClaudeCopilot } from '@/lib/copilot/claude';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 256 * 1024;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const available = () => process.env.TRA_CLAUDE_COPILOT_ENABLED === 'true'
  && process.env.TRA_CLAUDE_COPILOT_ALLOW_PAID === 'true' && Boolean(process.env.ANTHROPIC_API_KEY?.trim());

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid body');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('Oversized body'); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } finally { reader.releaseLock(); }
}

export async function GET() {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  return reply({ available: available(), model: CLAUDE_COPILOT_MODEL });
}

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  if (!available()) return reply({ error: 'Claude Copilot is unavailable.' }, 503);
  let body: unknown;
  try { body = await readBody(request); } catch { return reply({ error: 'Provide valid JSON within the 256 KB request limit.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Invalid recommendation request.' }, 400);
  const input = body as Record<string, unknown>;
  const fields = ['creativeId', 'companyProfile', 'companyContextApproved', 'allowPaidRequest'];
  if (Object.keys(input).length !== fields.length || fields.some(key => !(key in input)) || input.allowPaidRequest !== true) {
    return reply({ error: 'Explicit paid-request approval and the supported context fields are required.' }, 400);
  }
  try {
    const context = await buildSavedCopilotContext(input.creativeId, input.companyProfile, input.companyContextApproved);
    const denied = await requireOperatorQuota(access.userId, 'COPILOT_RECOMMENDATION', 1);
    if (denied) return denied;
    const recommendation = await requestClaudeCopilot(context, { apiKey: process.env.ANTHROPIC_API_KEY,
      allowPaidRequest: true, maxOutputTokens: 4096, signal: request.signal });
    return reply({ recommendation });
  } catch (error) {
    if (error instanceof CopilotContextError) {
      const status = error.code === 'creative_unavailable' ? 404 : 400;
      return reply({ error: error.code === 'approval_required' ? 'Approve the effective company context before requesting a recommendation.'
        : error.code === 'creative_unavailable' ? 'A saved creative with a valid identity is required.' : 'Invalid creative or company context.' }, status);
    }
    if (error instanceof ClaudeCopilotError && error.code === 'invalid_input') return reply({ error: 'The supplied context exceeds the provider input limits.' }, 400);
    return reply({ error: 'Claude Copilot could not complete the recommendation. Try again later.' }, 503);
  }
}
