import { readCopilotBody } from '@/lib/copilot/request-body';
import { getAnthropicCredential, getProviderSecretStatus, providerSecretsReady } from '@/lib/provider-secrets/anthropic';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { buildSavedCopilotContext, CopilotContextError } from '@/lib/copilot/context';
import { CLAUDE_COPILOT_MODEL, ClaudeCopilotError, requestClaudeCopilot } from '@/lib/copilot/claude';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { isPreviewAcceptance } from '@/lib/creatives/preview-acceptance';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 256 * 1024;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const paidEnabled = () => !isPreviewAcceptance() && process.env.TRA_CLAUDE_COPILOT_ENABLED === 'true'
  && process.env.TRA_CLAUDE_COPILOT_ALLOW_PAID === 'true'
  && process.env.TRA_CLAUDE_COPILOT_BYOK_ALLOW_PAID === 'true' && providerSecretsReady();

export async function GET() {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const configured = paidEnabled() && (await getProviderSecretStatus(access.userId)).configured;
    return reply({ available: Boolean(configured), model: CLAUDE_COPILOT_MODEL });
  } catch { return reply({ available: false, model: CLAUDE_COPILOT_MODEL }); }
}

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  if (isPreviewAcceptance()) return reply({ error: 'Preview acceptance does not authorize paid Copilot recommendations.' }, 409);
  if (!paidEnabled()) return reply({ error: 'Claude Copilot is unavailable.' }, 503);
  let body: unknown;
  try { body = await readCopilotBody(request, MAX_BODY_BYTES); } catch { return reply({ error: 'Provide valid JSON within the 256 KB request limit.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Invalid recommendation request.' }, 400);
  const input = body as Record<string, unknown>;
  const fields = ['creativeId', 'companyProfile', 'companyContextApproved', 'allowPaidRequest'];
  if (Object.keys(input).length !== fields.length || fields.some(key => !(key in input)) || input.allowPaidRequest !== true) {
    return reply({ error: 'Explicit paid-request approval and the supported context fields are required.' }, 400);
  }
  try {
    const context = await buildSavedCopilotContext(input.creativeId, input.companyProfile, input.companyContextApproved);
    const apiKey = await getAnthropicCredential(access.userId);
    if (!apiKey) return reply({ error: 'Save your own Anthropic API key in Copilot settings before requesting a suggestion.' }, 409);
    const denied = await requireOperatorQuota(access.userId, 'COPILOT_RECOMMENDATION', 1);
    if (denied) return denied;
    const recommendation = await requestClaudeCopilot(context, { apiKey,
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
