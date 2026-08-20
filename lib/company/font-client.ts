'use client';

import type { BrandFontAsset } from '@/lib/company/brand-fonts';
import type { MediaAsset } from '@/lib/media/types';

const toFile = (canvas: HTMLCanvasElement, fileName: string) =>
  new Promise<File>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The font preview could not be rendered.'));
        return;
      }
      resolve(new File([blob], fileName, { type: 'image/png' }));
    }, 'image/png');
  });

export async function uploadBrandFont(file: File): Promise<BrandFontAsset> {
  const formData = new FormData();
  formData.set('file', file);
  const response = await fetch('/api/company/fonts', {
    method: 'POST',
    body: formData,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'The font could not be uploaded.');
  }
  return payload as BrandFontAsset;
}

export async function createBrandFontSpecimen(
  file: File,
  asset: BrandFontAsset
): Promise<MediaAsset> {
  const family = `tra-font-${asset.id}`;
  const fontFace = new FontFace(family, await file.arrayBuffer());
  await fontFace.load();
  document.fonts.add(fontFace);

  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('The browser could not prepare the font specimen.');
  }

  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = `76px "${family}"`;
  context.fillText('Tax Relief Advocates', 56, 118, 1088);
  context.font = `52px "${family}"`;
  context.fillText('Clear answers. Confident next steps.', 56, 220, 1088);
  context.font = `32px "${family}"`;
  context.fillText('ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', 56, 300, 1088);

  const specimenFile = await toFile(canvas, `${asset.id}-specimen.png`);
  const formData = new FormData();
  formData.set('file', specimenFile);
  const response = await fetch('/api/media/upload', {
    method: 'POST',
    body: formData,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'The font specimen could not be saved.');
  }
  return payload as MediaAsset;
}

export async function analyzeBrandFontSpecimen(mediaId: string) {
  const response = await fetch('/api/company/fonts/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId }),
  });
  const payload = await response.json();
  if (!response.ok || typeof payload.description !== 'string') {
    throw new Error(payload.error || 'The font style could not be analyzed.');
  }
  return payload.description as string;
}

export async function loadBrandFontFace(asset: BrandFontAsset) {
  const family = `tra-font-${asset.id}`;
  const fontFace = new FontFace(family, `url("${asset.url}")`);
  await fontFace.load();
  document.fonts.add(fontFace);
  return family;
}

export async function removeBrandFontFile(asset: BrandFontAsset) {
  await fetch(`/api/company/fonts/${encodeURIComponent(asset.fileName)}`, {
    method: 'DELETE',
  });
}
