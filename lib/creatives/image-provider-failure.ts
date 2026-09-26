export class CreativeImageProviderError extends Error {
  constructor(message: string, readonly fallbackReason: string | null,
    readonly outcome: 'FAILED' | 'UNKNOWN' = 'FAILED', readonly httpStatus?: number) {
    super(message); this.name = 'CreativeImageProviderError';
  }
}

/** HTTP status alone cannot distinguish rate limits from exhausted credits/spend. */
export async function imageProviderFailure(response: Response): Promise<CreativeImageProviderError> {
  const error = await response.clone().json().then(body => body?.error).catch(() => null);
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const type = typeof error?.type === 'string' ? error.type.toLowerCase() : '';
  const terminal = /(?:billing|credit|quota|spend_limit|usage_limit|authentication|invalid_request|invalid_api_key|model_not_found)/.test(`${code} ${type}`);
  const overloaded = response.status === 503 && code === 'server_is_overloaded';
  const ambiguous = !terminal && (response.status === 408 || (response.status >= 500 && !overloaded));
  // A provider-requested delay is not permission for an immediate second paid call.
  const deferred = response.headers.has('Retry-After');
  const reason = terminal || ambiguous || deferred ? null
    : response.status === 429 && (code === 'rate_limit_exceeded' || (type === 'rate_limit_error' && !code))
      ? 'rate_limited'
      : overloaded ? 'provider_unavailable' : null;
  return new CreativeImageProviderError(`OpenAI image request failed (HTTP ${response.status}).`
    + (ambiguous ? ' Outcome is unknown; automatic replacement is disabled.' : ''),
  reason, ambiguous ? 'UNKNOWN' : 'FAILED', response.status);
}

// Legacy adapter helpers lack the structured response needed to authorize fallback.
export const creativeImageHttpError = (status: number, message: string) => new CreativeImageProviderError(message, null, 'FAILED', status);
export const creativeImageMissingOutputError = () => new CreativeImageProviderError(
  'OpenAI returned no generated image. Outcome is unknown; automatic replacement is disabled.', null, 'UNKNOWN');
