'use client';

import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { MediaAsset } from '@/lib/media/types';

const COMPANY_PROFILE_STORAGE_KEY = 'tra-company-profile-v2';
const STORED_MEDIA_URL = /\/api\/media\/files\/(media_[a-f0-9]{32})\.(?:png|jpg|webp)(?:\?.*)?$/;
const BRAND_BATCH_SIZE = 3;
const LOGO_LEFT_RATIO = 0.04;
const LOGO_TOP_RATIO = 0.04;
const LOGO_MAX_WIDTH_RATIO = 0.24;
const LOGO_MAX_HEIGHT_RATIO = 0.09;

interface UploadPlan {
  direct: boolean;
  uploadUrl?: string;
  media?: MediaAsset;
  error?: string;
}

export interface StoredBrandLogo {
  url: string;
  mediaId: string;
}

export function readStoredBrandLogo(): StoredBrandLogo | null {
  try {
    const raw = window.localStorage.getItem(COMPANY_PROFILE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      brandGuidelines?: { logo?: unknown };
    };
    const logo =
      typeof parsed.brandGuidelines?.logo === 'string'
        ? parsed.brandGuidelines.logo.trim()
        : '';
    if (!logo) return null;

    const match = STORED_MEDIA_URL.exec(logo);
    if (!match) return null;

    return { url: logo, mediaId: match[1] };
  } catch {
    return null;
  }
}

const uploadThroughServer = async (file: File): Promise<MediaAsset> => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/media/upload', {
    method: 'POST',
    body: formData,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Branded creative upload failed.');
  }

  return payload as MediaAsset;
};

const uploadMediaFile = async (file: File): Promise<MediaAsset> => {
  const planResponse = await fetch('/api/media/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
    }),
  });
  const plan = (await planResponse.json()) as UploadPlan;

  if (!planResponse.ok) {
    throw new Error(plan.error || 'Branded creative upload could not be prepared.');
  }

  if (!plan.direct) {
    return uploadThroughServer(file);
  }

  if (!plan.uploadUrl || !plan.media) {
    throw new Error('Branded creative upload could not be prepared.');
  }

  const putResponse = await fetch(plan.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!putResponse.ok) {
    throw new Error('Direct branded creative upload failed.');
  }

  const confirmResponse = await fetch('/api/media/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId: plan.media.id }),
  });
  const confirmation = await confirmResponse.json();
  if (!confirmResponse.ok) {
    throw new Error(
      confirmation.error || 'Branded creative could not be validated.'
    );
  }

  return plan.media;
};

const fetchBitmap = async (url: string, label: string) => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${label} could not be loaded.`);
  }

  return createImageBitmap(await response.blob());
};

const canvasToPngFile = (canvas: HTMLCanvasElement, fileName: string) =>
  new Promise<File>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('The branded creative could not be rendered.'));
          return;
        }
        resolve(new File([blob], fileName, { type: 'image/png' }));
      },
      'image/png',
      1
    );
  });

const brandOneCreative = async (
  creative: GeneratedCreative,
  logoUrl: string
): Promise<GeneratedCreative> => {
  const [creativeBitmap, logoBitmap] = await Promise.all([
    fetchBitmap(creative.image.url, 'Generated creative'),
    fetchBitmap(logoUrl, 'TRA logo'),
  ]);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = creativeBitmap.width;
    canvas.height = creativeBitmap.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('The browser could not prepare the branded creative.');
    }

    context.drawImage(creativeBitmap, 0, 0);

    const width = canvas.width;
    const height = canvas.height;
    const maxLogoWidth = width * LOGO_MAX_WIDTH_RATIO;
    const maxLogoHeight = height * LOGO_MAX_HEIGHT_RATIO;
    const scale = Math.min(
      maxLogoWidth / logoBitmap.width,
      maxLogoHeight / logoBitmap.height
    );
    const logoWidth = Math.max(1, Math.round(logoBitmap.width * scale));
    const logoHeight = Math.max(1, Math.round(logoBitmap.height * scale));
    const logoX = Math.round(width * LOGO_LEFT_RATIO);
    const logoY = Math.round(height * LOGO_TOP_RATIO);

    // The approved logo is the only branding layer added here. Keep the
    // source artwork intact: proportional resize only, no panel, crop,
    // recolor, opacity change, effects, or AI recreation.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      logoBitmap,
      logoX,
      logoY,
      logoWidth,
      logoHeight
    );

    const file = await canvasToPngFile(
      canvas,
      `tra-creative-${creative.index}-branded.png`
    );
    const image = await uploadMediaFile(file);

    return { ...creative, image };
  } finally {
    creativeBitmap.close();
    logoBitmap.close();
  }
};

export async function applyBrandLogoToCreatives(
  creatives: GeneratedCreative[],
  logoUrl: string
): Promise<GeneratedCreative[]> {
  const branded: GeneratedCreative[] = [];

  for (let offset = 0; offset < creatives.length; offset += BRAND_BATCH_SIZE) {
    const batch = creatives.slice(offset, offset + BRAND_BATCH_SIZE);
    branded.push(
      ...(await Promise.all(
        batch.map((creative) => brandOneCreative(creative, logoUrl))
      ))
    );
  }

  return branded;
}
