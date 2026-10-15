import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { changeAnthropicCredential, getProviderSecretStatus, ProviderSecretError, providerSecretsReady } from '@/lib/provider-secrets/anthropic';
import { readCopilotBody } from '@/lib/copilot/request-body';
import { isPreviewAcceptance } from '@/lib/creatives/preview-acceptance';
export const runtime = 'nodejs';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const unavailable = () => reply({ error: 'Private key storage is unavailable. An administrator must configure the server master key and private storage.' }, 503);
export async function GET() {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  if (!providerSecretsReady()) return reply({ ready: false, configured: false, revision: null, updatedAt: null });
  try { return reply({ ready: true, ...await getProviderSecretStatus(access.userId) }); } catch { return unavailable(); }
}
async function mutate(request: Request, remove: boolean) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  if (isPreviewAcceptance()) return reply({ error: 'Acceptance previews cannot change provider credentials.' }, 409);
  if (!providerSecretsReady()) return unavailable();
  let value: unknown;
  try { value = await readCopilotBody(request, 4096); } catch { return reply({ error: 'Provide valid JSON within 4 KB.' }, 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reply({ error: 'Invalid key request.' }, 400);
  const input = value as Record<string, unknown>, fields = remove ? ['revision'] : ['apiKey', 'revision'];
  if (Object.keys(input).length !== fields.length || fields.some(field => !(field in input))) return reply({ error: 'Only the key and current revision are supported.' }, 400);
  try { return reply({ ready: true, ...await changeAnthropicCredential(access.userId, remove ? null : input.apiKey, input.revision) }); }
  catch (error) {
    if (error instanceof ProviderSecretError && error.code === 'conflict') return reply({ error: 'Key settings changed in another session. Refresh before trying again.' }, 409);
    if (error instanceof ProviderSecretError && error.code === 'invalid_input') return reply({ error: 'Enter an Anthropic API key and refresh the current key status.' }, 400);
    return unavailable();
  }
}
export const POST = (request: Request) => mutate(request, false);
export const DELETE = (request: Request) => mutate(request, true);
