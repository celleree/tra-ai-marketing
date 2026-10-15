import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireOperatorAccess: vi.fn(),
  saveMedia: vi.fn(),
  getMediaDeliveryUrl: vi.fn(),
  readMediaById: vi.fn(),
  readMedia: vi.fn(),
}));
vi.mock('@/lib/auth/require-operator', () => ({
  requireOperatorAccess: mocks.requireOperatorAccess,
}));
vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: () => ({
    saveMedia: mocks.saveMedia,
    getMediaDeliveryUrl: mocks.getMediaDeliveryUrl,
    readMediaById: mocks.readMediaById,
    readMedia: mocks.readMedia,
  }),
}));

import { POST as upload } from '@/app/api/media/upload/route';
import { POST as uploadUrl } from '@/app/api/media/upload-url/route';
import { POST as confirm } from '@/app/api/media/confirm/route';
import { GET as mediaFile } from '@/app/api/media/files/[fileName]/route';

const deniedRequest = { formData: vi.fn(), json: vi.fn() } as unknown as Request;
const fileContext = { params: Promise.resolve({ fileName: 'fixture.png' }) };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const guardedRoutes = [
  ['upload', () => upload(deniedRequest)],
  ['upload-url', () => uploadUrl(deniedRequest)],
  ['confirm', () => confirm(deniedRequest)],
  ['file', () => mediaFile(deniedRequest, fileContext)],
] as const;

describe('media operator guards', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireOperatorAccess.mockResolvedValue(null);
    mocks.getMediaDeliveryUrl.mockResolvedValue(
      'https://bucket.account.r2.cloudflarestorage.com/fixture.png?signed=true'
    );
  });

  it.each([401, 403, 503].flatMap((status) =>
    guardedRoutes.map(([route, invoke]) => [status, route, invoke] as const)
  ))('returns %i from %s before accessing route inputs', async (status, _route, invoke) => {
    mocks.requireOperatorAccess.mockResolvedValue(new Response('denied', { status }));
    expect((await invoke()).status).toBe(status);
    expect(deniedRequest.formData).not.toHaveBeenCalled();
    expect(deniedRequest.json).not.toHaveBeenCalled();
    expect(mocks.saveMedia).not.toHaveBeenCalled();
    expect(mocks.getMediaDeliveryUrl).not.toHaveBeenCalled();
    expect(mocks.readMediaById).not.toHaveBeenCalled();
    expect(mocks.readMedia).not.toHaveBeenCalled();
  });

  it('preserves authorized upload, confirmation, direct-upload, and file responses', async () => {
    mocks.saveMedia.mockResolvedValue({ id: 'media_upload', fileName: 'media_upload.png' });
    const formData = new FormData();
    formData.set('file', new File([png], 'fixture.png', { type: 'image/png' }));
    expect((await upload({ formData: async () => formData } as Request)).status).toBe(201);

    mocks.readMediaById.mockResolvedValue({ mimeType: 'image/png', mediaType: 'IMAGE', buffer: png });
    expect((await confirm(new Request('http://localhost/confirm', {
      method: 'POST', body: JSON.stringify({ mediaId: 'media_upload' }),
    }))).status).toBe(200);
    expect((await uploadUrl(new Request('http://localhost/upload-url', { method: 'POST' }))).json())
      .resolves.toEqual({ direct: false });

    const response = await mediaFile(new Request('http://localhost/file'), fileContext);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('r2.cloudflarestorage.com');
    expect(mocks.readMedia).not.toHaveBeenCalled();
  });
});
