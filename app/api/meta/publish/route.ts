import { NextResponse } from 'next/server';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import { getMediaStorage } from '@/lib/media/local-storage';
import {
  createMetaAdCreative,
  createPausedMetaAd,
  createPausedMetaAdSet,
  createPausedMetaCampaign,
  MetaApiError,
  uploadMetaAdImage,
} from '@/lib/meta/client';
import type {
  MetaCtaType,
  MetaPublishBatchResult,
  MetaPublishCreativeInput,
  MetaPublishCreativeResult,
} from '@/lib/meta/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface PublishBody {
  adAccountId?: string;
  pageId?: string;
  destinationUrl?: string;
  dailyBudgetCents?: number;
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

const batchStamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

const chooseCta = (creative: MetaPublishCreativeInput): MetaCtaType => {
  const text = `${creative.copy.headline} ${creative.copy.primaryText} ${creative.copy.description}`.toLowerCase();
  if (/\bapply\b|\bapplication\b/.test(text)) return 'APPLY_NOW';
  if (/\bcontact\b|\bcall\b|\bspeak\b|\btalk\b|\bconsult/.test(text)) return 'CONTACT_US';
  return 'LEARN_MORE';
};

export async function POST(request: Request) {
  let campaignId = '';

  try {
    const body = (await request.json()) as PublishBody;
    const adAccountId = body.adAccountId?.trim() || '';
    const pageId = body.pageId?.trim() || '';
    const destinationUrl = body.destinationUrl?.trim() || '';
    const creatives = Array.isArray(body.creatives) ? body.creatives : [];
    const dailyBudgetCents = Number(body.dailyBudgetCents || 2000);

    if (!adAccountId || !pageId) {
      return NextResponse.json(
        { error: 'Ad account and Facebook Page are required.' },
        { status: 400 }
      );
    }
    if (!isValidUrl(destinationUrl)) {
      return NextResponse.json(
        { error: 'Enter a valid http or https destination URL.' },
        { status: 400 }
      );
    }
    if (
      !Number.isInteger(dailyBudgetCents) ||
      dailyBudgetCents < 500 ||
      dailyBudgetCents > 100000
    ) {
      return NextResponse.json(
        { error: 'Daily budget must be between 500 and 100000 minor currency units.' },
        { status: 400 }
      );
    }
    if (!creatives.length || creatives.length > 30) {
      return NextResponse.json(
        { error: 'Select between 1 and 30 creatives.' },
        { status: 400 }
      );
    }

    const stamp = batchStamp();
    campaignId = await createPausedMetaCampaign({
      adAccountId,
      name: `TRA AI | Creative Batch | ${stamp} UTC`.slice(0, 255),
    });

    const adSetId = await createPausedMetaAdSet({
      adAccountId,
      campaignId,
      name: `TRA AI | Broad US | Landing Page Views | ${stamp} UTC`.slice(0, 255),
      dailyBudgetCents,
    });

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
        const ctaType = chooseCta(creative);

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
          ctaType,
        });
      } catch (error) {
        const message =
          error instanceof MetaApiError || error instanceof Error
            ? error.message
            : 'Meta publishing failed for this creative.';
        results.push({ creativeId, status: 'failed', error: message });
      }
    }

    const payload: MetaPublishBatchResult = {
      campaignId,
      adSetId,
      campaignStatus: 'PAUSED',
      adSetStatus: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      optimizationGoal: 'LANDING_PAGE_VIEWS',
      results,
    };

    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meta publishing failed.';
    return NextResponse.json(
      {
        error: message,
        ...(campaignId ? { campaignId, campaignStatus: 'PAUSED' } : {}),
      },
      { status: 500 }
    );
  }
}
