export type CreativeUploadStage = 'prepare' | 'transfer' | 'confirm' | 'save';

const labels: Record<CreativeUploadStage, string> = {
  prepare: 'Prepare upload',
  transfer: 'Transfer image',
  confirm: 'Confirm image',
  save: 'Save creative',
};

type Failure = 'network' | 'http' | 'response';

export class CreativeUploadError extends Error {
  constructor(stage: CreativeUploadStage, failure: Failure, status?: number) {
    let reason = 'The service returned an unreadable or incomplete response. Retry the file.';
    if (failure === 'network') {
      reason = stage === 'transfer'
        ? 'The browser could not complete the image transfer. Check the connection and storage access before retrying.'
        : 'The browser could not reach the service. Check the connection before retrying.';
      if (stage === 'save') reason += ' Check TRA creatives first; the save may have completed.';
    } else if (failure === 'http') {
      reason = `HTTP ${status}. `;
      if (status === 401 && stage !== 'transfer') reason += 'Sign in again, then retry the file.';
      else if (status === 403) reason += stage === 'transfer'
        ? 'Storage rejected the transfer. Check storage access before retrying.'
        : 'Operator access was denied. Check your access before retrying.';
      else if (status === 413) reason += 'The file exceeds the upload limit. Choose a smaller image.';
      else if (status === 404 && stage === 'confirm') reason += 'The uploaded image was not found. Retry the file.';
      else if (status === 409 && stage === 'save') reason += 'The save conflicted. Check TRA creatives before retrying.';
      else if (status === 400) reason += stage === 'save'
        ? 'The request was rejected. Check the image and required copy before retrying.'
        : 'The request was rejected. Check the image file before retrying.';
      else reason += 'The service could not complete this step. Retry the file when it is available.';
      if (stage === 'save' && status !== undefined && status >= 500) {
        reason += ' Check TRA creatives first; the save may have completed.';
      }
    } else if (stage === 'save') {
      reason += ' Check TRA creatives first; the save may have completed.';
    }
    super(`${labels[stage]}: ${reason}`);
    this.name = 'CreativeUploadError';
  }
}

// Never expose raw fetch exceptions, response bodies, signed URLs or storage paths.
export async function requestCreativeUpload(
  stage: CreativeUploadStage,
  input: string,
  init: RequestInit
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new CreativeUploadError(stage, 'network');
  }
  if (!response.ok) throw new CreativeUploadError(stage, 'http', response.status);
  return response;
}

export async function readCreativeUploadResponse<T>(
  stage: CreativeUploadStage,
  response: Response
): Promise<T> {
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload as T;
  } catch {
    throw new CreativeUploadError(stage, 'response');
  }
}

export function creativeUploadFailureMessage(error: unknown, stage: CreativeUploadStage): string {
  return error instanceof CreativeUploadError
    ? error.message
    : new CreativeUploadError(stage, 'response').message;
}
