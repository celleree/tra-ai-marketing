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

interface DrawableImage {
  image: HTMLImageElement;
  width: number;
  height: number;
  release: () => void;
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

  let putResponse: Response;
  try {
    putResponse = await fetch(plan.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
  } catch {
    // Preview deployments can have a different browser origin than the R2 CORS
    // allow-list. Keep branding reliable by falling back to the same-origin
    // server upload path instead of surfacing a generic browser fetch error.
    return uploadThroughServer(file);
  }

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

const toSameOriginMediaUrl = (url: string) => {
  try {
    const resolved = new URL(url, window.location.origin);
    if (resolved.pathname.startsWith('/api/media/files/')) {
      return `${resolved.pathname}${resolved.search}`;
    }
  } catch {
    // Keep non-media relative URLs such as the canonical public logo unchanged.
  }
  return url;
};

const fetchDrawableImage = async (
  url: string,
  label: string
): Promise<DrawableImage> => {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error(`${label} could not be fetched from this deployment.`);
  }

  if (!response.ok) {
    throw new Error(`${label} could not be loaded (HTTP ${response.status}).`);
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new Error(`${label} returned an empty image.`);
  }

  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = 'async';
  image.src = objectUrl;

  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error(`${label} could not be decoded.`);
  }

  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(objectUrl);
    throw new Error(`${label} has invalid dimensions.`);
  }

  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(objectUrl),
  };
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
  // MediaAsset.url is intentionally stable for attribution and may point at
  // production. For browser-side compositing, read the same R2 object through
  // this deployment's media proxy so preview origins never cross-fetch prod.
  const creativeUrl = `/api/media/files/${creative.image.fileName}`;
  const safeLogoUrl = toSameOriginMediaUrl(logoUrl);
  const [creativeSource, logoSource] = await Promise.all([
    fetchDrawableImage(creativeUrl, 'Generated creative'),
    fetchDrawableImage(safeLogoUrl, 'TRA logo'),
  ]);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = creativeSource.width;
    canvas.height = creativeSource.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('The browser could not prepare the branded creative.');
    }

    context.drawImage(creativeSource.image, 0, 0);

    const width = canvas.width;
    const height = canvas.height;
    const maxLogoWidth = width * LOGO_MAX_WIDTH_RATIO;
    const maxLogoHeight = height * LOGO_MAX_HEIGHT_RATIO;
    const scale = Math.min(
      maxLogoWidth / logoSource.width,
      maxLogoHeight / logoSource.height
    );
    const logoWidth = Math.max(1, Math.round(logoSource.width * scale));
    const logoHeight = Math.max(1, Math.round(logoSource.height * scale));
    const logoX = Math.round(width * LOGO_LEFT_RATIO);
    const logoY = Math.round(height * LOGO_TOP_RATIO);

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      logoSource.image,
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
    creativeSource.release();
    logoSource.release();
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
