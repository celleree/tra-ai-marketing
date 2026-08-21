import { NextResponse } from 'next/server';
import { classifyReferenceCreativeAngle } from '@/lib/ai/reference-angle';
import { getMediaStorage } from '@/lib/media/local-storage';
import {
  detectImageMimeType,
  getMaxUploadBytes,
} from '@/lib/media/storage';
import type { AllowedImageMimeType } from '@/lib/media/types';
import { findWinningCreativeCandidates } from '@/lib/references/discovery';
import { addToReferenceLibrary } from '@/lib/references/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

const extensionForMime: Record<AllowedImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const safeName = (value: string) =>
  value
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'advertiser';

const downloadCandidate = async (candidate: Awaited<ReturnType<typeof findWinningCreativeCandidates>>[number]) => {
  const response = await fetch(candidate.imageUrl, {
    headers: {
      'User-Agent': 'TRA-AI-Marketing/1.0',
      Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Creative image returned ${response.status}.`);
  }

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > getMaxUploadBytes()) {
    throw new Error('Creative image is larger than the upload limit.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > getMaxUploadBytes()) {
    throw new Error('Creative image is empty or larger than the upload limit.');
  }

  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) {
    throw new Error('Creative is not a supported PNG, JPEG, or WebP image.');
  }

  const originalName = `ai-found-${safeName(candidate.advertiser)}-${safeName(candidate.adId)}.${extensionForMime[mimeType]}`;
  const file = new File([buffer], originalName, { type: mimeType });
  return getMediaStorage().saveImage(file);
};

export async function POST() {
  try {
    const candidates = await findWinningCreativeCandidates();
    if (!candidates.length) {
      return NextResponse.json({
        items: await addToReferenceLibrary([]),
        imported: 0,
        discovered: 0,
        failures: [],
      });
    }

    const storage = getMediaStorage();
    const additions = [];
    const failures: string[] = [];

    for (const candidate of candidates) {
      try {
        const media = await downloadCandidate(candidate);
        let angle = 'customer-problems' as const;
        let angleSource = 'fallback' as const | 'ai';

        if (process.env.OPENAI_API_KEY) {
          try {
            const source = await storage.readImageById(media.id);
            if (source) {
              angle = await classifyReferenceCreativeAngle(source);
              angleSource = 'ai';
            }
          } catch (classificationError) {
            console.error(`Reference finder classification failed for ${media.id}`, classificationError);
          }
        }

        additions.push({
          media,
          angle,
          angleSource,
          origin: 'ai-found' as const,
          discovery: {
            provider: candidate.provider,
            advertiser: candidate.advertiser,
            sourceUrl: candidate.sourceUrl,
            adId: candidate.adId,
            startDate: candidate.startDate,
            discoveredAt: new Date().toISOString(),
            searchTerm: candidate.searchTerm,
          },
        });
      } catch (error) {
        failures.push(
          `${candidate.advertiser}: ${error instanceof Error ? error.message : 'Could not import creative.'}`
        );
      }
    }

    const items = await addToReferenceLibrary(additions);
    return NextResponse.json({
      items,
      imported: additions.length,
      discovered: candidates.length,
      failures: failures.slice(0, 10),
    });
  } catch (error) {
    console.error('Winning Creative Finder failed', error);
    const message = error instanceof Error ? error.message : 'Winning Creative Finder failed.';
    const needsSetup = message.includes('APIFY_TOKEN');
    return NextResponse.json(
      { error: message, needsSetup },
      { status: needsSetup ? 503 : 500 }
    );
  }
}
