import type { CreativeSourceVideoAsset } from '@/lib/media/types';

const sourceRole = 'TRA_VIDEO';
type UploadPayload = Partial<CreativeSourceVideoAsset> & { error?: string; sourceRole?: string };
type UploadPlan = { direct?: boolean; uploadUrl?: string; media?: UploadPayload; sourceRole?: string; error?: string };

const readPayload = async <T extends { error?: string }>(response: Response): Promise<T> => {
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(payload.error || `Video upload failed (HTTP ${response.status}).`);
  return payload;
};

const requireVideo = (media: UploadPayload | undefined): CreativeSourceVideoAsset => {
  if (!media?.id || !media.fileName || !media.url || media.mediaType !== 'VIDEO' || media.mimeType !== 'video/mp4'
    || (media.sourceRole !== undefined && media.sourceRole !== sourceRole)) {
    throw new Error('The upload did not preserve the TRA video source.');
  }
  return media as CreativeSourceVideoAsset;
};

export const uploadTraVideo = async (file: File, request: typeof fetch = fetch): Promise<CreativeSourceVideoAsset> => {
  const plan = await readPayload<UploadPlan>(await request('/api/media/upload-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, size: file.size, sourceRole }),
  }));
  if (plan.direct === false) {
    const form = new FormData();
    form.append('file', file);
    form.append('sourceRole', sourceRole);
    return requireVideo(await readPayload<UploadPayload>(await request('/api/media/upload', { method: 'POST', body: form })));
  }
  if (plan.direct !== true || !plan.uploadUrl || (plan.sourceRole !== undefined && plan.sourceRole !== sourceRole)) {
    throw new Error('The video upload could not be prepared.');
  }
  const media = requireVideo(plan.media);
  const uploaded = await request(plan.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!uploaded.ok) throw new Error(`Direct video upload failed (HTTP ${uploaded.status}).`);
  await readPayload(await request('/api/media/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId: media.id, mimeType: media.mimeType, mediaType: media.mediaType, sourceRole }),
  }));
  return media;
};
