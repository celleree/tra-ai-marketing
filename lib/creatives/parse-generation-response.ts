import type { GeneratedCreative } from '@/lib/creatives/generated';

export type CreativeGenerationPayload = {
  creatives?: GeneratedCreative[];
  error?: string;
};

const invalidResponseError = (response: Response) =>
  response.ok
    ? 'Creative generation returned an invalid server response.'
    : `Creative generation was interrupted by the server before it could return a normal response (HTTP ${response.status}).`;

export const parseGenerationResponse = async (
  response: Response
): Promise<CreativeGenerationPayload> => {
  const raw = await response.text();
  if (!raw.trim()) {
    return {
      error: `Creative generation returned an empty server response (HTTP ${response.status}).`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: invalidResponseError(response) };
    }

    return parsed as CreativeGenerationPayload;
  } catch {
    return { error: invalidResponseError(response) };
  }
};
