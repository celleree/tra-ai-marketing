import { NextResponse } from 'next/server';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import { recordCreativeMetaAttribution } from '@/lib/creatives/attribution';
import { isSafeCreativeId, listCreatives } from '@/lib/creatives/storage';
import { getMediaStorage } from '@/lib/media/local-storage';
import { getPublicMediaUrl } from '@/lib/media/storage';
import {
  createMetaAdCreative,
  createPausedMetaAd,
  createPausedMetaAdSet,
  createPausedMetaCampaign,
  listMetaPromotablePages,
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
  creativeIds?: unknown;
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
    const requestedPageId = body.pageId?.trim() || '';
    const destinationUrl = body.destinationUrl?.trim() || '';
    const creativeIds = body.creativeIds;
    const dailyBudgetCents = Number(body.dailyBudgetCents || 2000);

    if (!adAccountId || !requestedPageId) {
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
    if (!Array.isArray(creativeIds) || !creativeIds.length || creativeIds.length > 30 ||
      !creativeIds.every((id): id is string => typeof id === 'string' && isSafeCreativeId(id)) ||
      new Set(creativeIds).size !== creativeIds.length) {
      return NextResponse.json(
        { error: 'Select between 1 and 30 distinct saved creatives.' },
        { status: 400 }
      );
    }

    // Release the saved image and copy that were reviewed, never client-supplied content.
    const saved = new Map((await listCreatives()).map(creative => [creative.id, creative]));
    const blocked = creativeIds.flatMap(id => {
      const creative = saved.get(id);
      const reason = !creative ? 'not found' : creative.humanReview?.status !== 'APPROVED'
        ? 'human review required' : creative.lifecycle?.status === 'PAUSED'
          ? 'paused in library' : !creative.format ? 'missing saved format' : null;
      return reason ? [{ id, reason }] : [];
    });
    if (blocked.length) return NextResponse.json({
      error: `Review and activate all selected creatives in TRA Creatives before sending to Meta. Blocked: ${blocked.map(item => `${item.id} (${item.reason})`).join(', ')}.`,
      blocked,
    }, { status: 409 });
    const creatives: MetaPublishCreativeInput[] = creativeIds.map(id => {
      const creative = saved.get(id)!;
      return { id, imageId: creative.image.id, category: creative.category,
        format: creative.format!, source: creative.source ?? 'generated', copy: creative.copy };
    });

    const promotablePages = await listMetaPromotablePages(adAccountId);
    const requestedPage = promotablePages.find((page) => page.id === requestedPageId);
    const resolvedPage = requestedPage || (promotablePages.length === 1 ? promotablePages[0] : null);

    if (!resolvedPage) {
      const available = promotablePages.map((page) => page.name).filter(Boolean).join(', ');
      return NextResponse.json(
        {
          error: promotablePages.length
            ? `The saved Facebook Page cannot be advertised from this ad account. Open Meta setup and choose one of this account's promotable Pages: ${available}.`
            : 'This ad account has no promotable Facebook Pages available to the current Meta token. Check the Page/ad-account asset access in Meta Business settings.',
        },
        { status: 400 }
      );
    }

    const pageId = resolvedPage.id;
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
      let stage = 'validating creative data';
      let imageHash = '';
      let metaCreativeId = '';

      try {
        if (!creativeId || !creative.imageId || !creative.copy?.headline || !creative.copy?.primaryText) {
          throw new Error('Creative data is incomplete.');
        }

        stage = 'loading image';
        const image = await storage.readImageById(creative.imageId);
        if (!image) {
          throw new Error('The creative image could not be found in media storage.');
        }

        stage = 'uploading image to Meta';
        imageHash = await uploadMetaAdImage(adAccountId, image);
        const uploaded = creative.source === 'uploaded';
        const categoryLabel = uploaded
          ? 'Uploaded'
          : CREATIVE_CATEGORY_LABELS[creative.category as keyof typeof CREATIVE_CATEGORY_LABELS] || creative.category;
        const formatLabel = uploaded
          ? 'Static Image'
          : CREATIVE_FORMAT_LABELS[creative.format as keyof typeof CREATIVE_FORMAT_LABELS] || creative.format;
        const adName = [
          'TRA',
          uploaded ? 'Upload' : 'AI',
          cleanNamePart(categoryLabel),
          cleanNamePart(formatLabel),
          cleanNamePart(creativeId),
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 255);
        const ctaType = chooseCta(creative);

        stage = 'creating Meta ad creative';
        metaCreativeId = await createMetaAdCreative({
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

        stage = 'creating Meta ad';
        const metaAdId = await createPausedMetaAd({
          adAccountId,
          adSetId,
          creativeId: metaCreativeId,
          name: adName,
        });

        const creativeUrl = getPublicMediaUrl(image.fileName);
        let attributionSaved = true;
        let attributionWarning = '';

        try {
          await recordCreativeMetaAttribution({
            creativeId,
            mediaId: creative.imageId,
            fileName: image.fileName,
            creativeUrl,
            source: uploaded ? 'uploaded' : 'generated',
            category: creative.category,
            format: creative.format,
            adAccountId,
            campaignId,
            adSetId,
            metaAdId,
            metaCreativeId,
            metaImageHash: imageHash,
          });
        } catch (error) {
          attributionSaved = false;
          attributionWarning =
            error instanceof Error
              ? error.message
              : 'Creative attribution could not be persisted.';
          console.error('Creative attribution save failed', {
            creativeId,
            metaAdId,
            metaCreativeId,
            error: attributionWarning,
          });
        }

        results.push({
          creativeId,
          status: 'success',
          metaAdId,
          metaCreativeId,
          metaImageHash: imageHash,
          creativeUrl,
          attributionSaved,
          ...(attributionWarning ? { attributionWarning } : {}),
          adStatus: 'PAUSED',
          ctaType,
        });
      } catch (error) {
        const baseMessage =
          error instanceof MetaApiError || error instanceof Error
            ? error.message
            : 'Meta publishing failed for this creative.';
        const message = `${stage}: ${baseMessage}`;
        console.error('Meta ad creation failed', {
          campaignId,
          adSetId,
          creativeId,
          stage,
          error: baseMessage,
        });
        results.push({
          creativeId,
          status: 'failed',
          ...(imageHash ? { metaImageHash: imageHash } : {}),
          ...(metaCreativeId ? { metaCreativeId } : {}),
          error: message,
        });
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
    console.error('Meta publish batch failed', { campaignId, error: message });
    return NextResponse.json(
      {
        error: message,
        ...(campaignId ? { campaignId, campaignStatus: 'PAUSED' } : {}),
      },
      { status: 500 }
    );
  }
}
