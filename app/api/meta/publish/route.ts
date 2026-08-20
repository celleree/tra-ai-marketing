import { NextResponse } from 'next/server';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import { getMediaStorage } from '@/lib/media/local-storage';
import {
  createMetaAdCreative,
  createPausedMetaAd,
  MetaApiError,
  uploadMetaAdImage,
} from '@/lib/meta/client';
import {
  META_CTA_TYPES,
  type MetaCtaType,
  type MetaPublishCreativeInput,
  type MetaPublishCreativeResult,
} from '@/lib/meta/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface PublishBody {
  adAccountId?: string;
  adSetId?: string;
  pageId?: string;
  destinationUrl?: string;
  ctaType?: MetaCtaType | '';
  creatives?: MetaPublishCreativeInput[];
}

const isValidUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

const cleanNamePart = (value: string) =>
  value.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PublishBody;
    const adAccountId = body.adAccountId?.trim() || '';
    const adSetId = body.adSetId?.trim() || '';
    const pageId = body.pageId?.trim() || '';
    const destinationUrl = body.destinationUrl?.trim() || '';
    const creatives = Array.isArray(body.creatives) ? body.creatives : [];
    const ctaType = body.ctaType || undefined;

    if (!adAccountId || !adSetId || !pageId) {
      return NextResponse.json(
        { error: 'Ad account, ad set, and Facebook Page are required.' },
        { status: 400 }
      );
    }
    if (!isValidUrl(destinationUrl)) {
      return NextResponse.json(
        { error: 'Enter a valid http or https destination URL.' },
        { status: 400 }
      );
    }
    if (ctaType && !META_CTA_TYPES.includes(ctaType)) {
      return NextResponse.json({ error: 'Unsupported CTA type.' }, { status: 400 });
    }
    if (!creatives.length || creatives.length > 30) {
      return NextResponse.json(
        { error: 'Select between 1 and 30 creatives.' },
        { status: 400 }
      );
    }

    const storage = getMediaStorage();
    const results: MetaPublishCreativeResult[] = [];

    for (const creative of creatives) {
      const creativeId = typeof creative.id === 'string' ? creative.id : '';
      try {
        if (!creativeId || !creative.imageId || !creative.copy?.headline || !creative.copy?.primaryText) {
          throw new Error('Creative data is incomplete.');
        }

        const image = await storage.readImageById(creative.imageId);
        if (!image) {
          throw new Error('The generated image could not be found in media storage.');
        }

        const imageHash = await uploadMetaAdImage(adAccountId, image);
        const categoryLabel =
          CREATIVE_CATEGORY_LABELS[creative.category as keyof typeof CREATIVE_CATEGORY_LABELS] || creative.category;
        const formatLabel =
          CREATIVE_FORMAT_LABELS[creative.format as keyof typeof CREATIVE_FORMAT_LABELS] || creative.format;
        const adName = [
          'TRA',
          'AI',
          cleanNamePart(categoryLabel),
          cleanNamePart(formatLabel),
          cleanNamePart(creativeId),
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 255);

        const metaCreativeId = await createMetaAdCreative({
          adAccountId,
          name: `${adName} | Creative`.slice(0, 255),
          pageId,
          imageHash,
          destinationUrl,
          primaryText: creative.copy.primaryText,
          headline: creative.copy.headline,
          description: creative.copy.description || '',
          ctaType,
        });
        const metaAdId = await createPausedMetaAd({
          adAccountId,
          adSetId,
          creativeId: metaCreativeId,
          name: adName,
        });

        results.push({
          creativeId,
          status: 'success',
          metaAdId,
          metaCreativeId,
          metaImageHash: imageHash,
          adStatus: 'PAUSED',
        });
      } catch (error) {
        const message =
          error instanceof MetaApiError || error instanceof Error
            ? error.message
            : 'Meta publishing failed for this creative.';
        results.push({ creativeId, status: 'failed', error: message });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meta publishing failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
