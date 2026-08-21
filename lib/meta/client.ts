import type { StoredMediaFile } from '@/lib/media/types';
import type { MetaAdAccount, MetaCtaType, MetaListItem } from '@/lib/meta/types';

const DEFAULT_META_GRAPH_API_VERSION = 'v25.0';
export const DEFAULT_TRA_META_URL_TAGS =
  '_ef_transaction_id=&source_id=&affid=6&sub1={{campaign.id}}&sub2={{adset.id}}&sub3={{ad.id}}&sub4={{placement}}&sub5=ci&oid=73';

interface MetaCollection<T> {
  data?: T[];
}

interface MetaApiErrorPayload {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    error_data?: unknown;
    fbtrace_id?: string;
  };
}

export class MetaApiError extends Error {
  readonly code?: number;
  readonly subcode?: number;

  constructor(message: string, code?: number, subcode?: number) {
    super(message);
    this.name = 'MetaApiError';
    this.code = code;
    this.subcode = subcode;
  }
}

const getConfig = () => {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    throw new MetaApiError('META_ACCESS_TOKEN is not configured.');
  }

  const version = process.env.META_GRAPH_API_VERSION || DEFAULT_META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new MetaApiError('META_GRAPH_API_VERSION must look like v25.0.');
  }

  return { accessToken, version };
};

const normalizeAdAccountId = (value: string) => {
  const trimmed = value.trim();
  const numeric = trimmed.startsWith('act_') ? trimmed.slice(4) : trimmed;
  if (!/^\d+$/.test(numeric)) {
    throw new MetaApiError('Invalid Meta ad account ID.');
  }
  return `act_${numeric}`;
};

const assertGraphId = (value: string, label: string) => {
  if (!/^\d+$/.test(value.trim())) {
    throw new MetaApiError(`Invalid ${label}.`);
  }
  return value.trim();
};

const parseError = async (response: Response) => {
  try {
    const payload = (await response.json()) as MetaApiErrorPayload;
    const metaError = payload.error;
    const detailParts = [
      metaError?.message,
      metaError?.error_user_title,
      metaError?.error_user_msg,
      metaError?.code ? `code ${metaError.code}` : '',
      metaError?.error_subcode ? `subcode ${metaError.error_subcode}` : '',
    ].filter(Boolean);

    return new MetaApiError(
      detailParts.length
        ? detailParts.join(' · ')
        : `Meta API request failed with status ${response.status}.`,
      metaError?.code,
      metaError?.error_subcode
    );
  } catch {
    return new MetaApiError(`Meta API request failed with status ${response.status}.`);
  }
};

const request = async <T>(
  path: string,
  init: RequestInit = {},
  query?: Record<string, string>
): Promise<T> => {
  const { accessToken, version } = getConfig();
  const url = new URL(`https://graph.facebook.com/${version}/${path.replace(/^\//, '')}`);
  Object.entries(query || {}).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as T;
};

const createAccountObject = async (
  adAccountId: string,
  edge: string,
  fields: Record<string, string>
) => {
  const accountId = normalizeAdAccountId(adAccountId);
  const body = new URLSearchParams(fields);
  const payload = await request<{ id?: string }>(`${accountId}/${edge}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!payload.id) {
    throw new MetaApiError(`Meta returned no ${edge.replace(/s$/, '')} ID.`);
  }
  return payload.id;
};

export const listMetaAdAccounts = async (): Promise<MetaAdAccount[]> => {
  const payload = await request<
    MetaCollection<{ id: string; name: string; currency?: string; account_status?: number }>
  >('me/adaccounts', {}, {
    fields: 'id,name,currency,account_status',
    limit: '100',
  });

  return (payload.data || []).map((item) => ({
    id: item.id,
    name: item.name,
    currency: item.currency,
    accountStatus: item.account_status,
  }));
};

export const listMetaCampaigns = async (adAccountId: string): Promise<MetaListItem[]> => {
  const accountId = normalizeAdAccountId(adAccountId);
  const payload = await request<
    MetaCollection<{ id: string; name: string; status?: string; effective_status?: string }>
  >(`${accountId}/campaigns`, {}, {
    fields: 'id,name,status,effective_status',
    limit: '100',
  });

  return (payload.data || []).map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    effectiveStatus: item.effective_status,
  }));
};

export const listMetaAdSets = async (campaignId: string): Promise<MetaListItem[]> => {
  const id = assertGraphId(campaignId, 'Meta campaign ID');
  const payload = await request<
    MetaCollection<{ id: string; name: string; status?: string; effective_status?: string }>
  >(`${id}/adsets`, {}, {
    fields: 'id,name,status,effective_status',
    limit: '100',
  });

  return (payload.data || []).map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    effectiveStatus: item.effective_status,
  }));
};

export const listMetaPages = async (): Promise<MetaListItem[]> => {
  const payload = await request<MetaCollection<{ id: string; name: string }>>(
    'me/accounts',
    {},
    { fields: 'id,name', limit: '100' }
  );

  return (payload.data || []).map((item) => ({ id: item.id, name: item.name }));
};

export const listMetaPromotablePages = async (
  adAccountId: string
): Promise<MetaListItem[]> => {
  const accountId = normalizeAdAccountId(adAccountId);
  const payload = await request<MetaCollection<{ id: string; name: string }>>(
    `${accountId}/promote_pages`,
    {},
    { fields: 'id,name', limit: '100' }
  );

  return (payload.data || []).map((item) => ({ id: item.id, name: item.name }));
};

export const createPausedMetaCampaign = async (args: {
  adAccountId: string;
  name: string;
}) =>
  createAccountObject(args.adAccountId, 'campaigns', {
    name: args.name,
    objective: 'OUTCOME_TRAFFIC',
    buying_type: 'AUCTION',
    special_ad_categories: JSON.stringify([]),
    is_adset_budget_sharing_enabled: 'false',
    status: 'PAUSED',
  });

export const createPausedMetaAdSet = async (args: {
  adAccountId: string;
  campaignId: string;
  name: string;
  dailyBudgetCents: number;
}) => {
  const campaignId = assertGraphId(args.campaignId, 'Meta campaign ID');
  if (!Number.isInteger(args.dailyBudgetCents) || args.dailyBudgetCents < 500) {
    throw new MetaApiError('Meta daily budget must be at least 500 minor currency units.');
  }

  return createAccountObject(args.adAccountId, 'adsets', {
    name: args.name,
    campaign_id: campaignId,
    status: 'PAUSED',
    daily_budget: String(args.dailyBudgetCents),
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LANDING_PAGE_VIEWS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    destination_type: 'WEBSITE',
    is_dynamic_creative: 'false',
    targeting: JSON.stringify({
      age_min: 25,
      age_max: 65,
      geo_locations: {
        countries: ['US'],
        location_types: ['home', 'recent'],
      },
    }),
  });
};

export const uploadMetaAdImage = async (
  adAccountId: string,
  image: StoredMediaFile
): Promise<string> => {
  const accountId = normalizeAdAccountId(adAccountId);
  const form = new FormData();
  form.set(
    'filename',
    new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
    image.fileName
  );

  const payload = await request<{ images?: Record<string, { hash?: string }> }>(
    `${accountId}/adimages`,
    { method: 'POST', body: form }
  );

  const hash = Object.values(payload.images || {})[0]?.hash;
  if (!hash) {
    throw new MetaApiError('Meta accepted the image upload but returned no image hash.');
  }
  return hash;
};

export const createMetaAdCreative = async (args: {
  adAccountId: string;
  name: string;
  pageId: string;
  imageHash: string;
  destinationUrl: string;
  primaryText: string;
  headline: string;
  description?: string;
  ctaType?: MetaCtaType;
  urlTags?: string;
}) => {
  const accountId = normalizeAdAccountId(args.adAccountId);
  const pageId = assertGraphId(args.pageId, 'Facebook Page ID');
  const description = (args.description || '').trim();
  const urlTags = (
    args.urlTags ?? process.env.META_URL_TAGS ?? DEFAULT_TRA_META_URL_TAGS
  )
    .trim()
    .replace(/^\?/, '');
  const destination = new URL(args.destinationUrl);
  const trackingKeys = [
    '_ef_transaction_id',
    'source_id',
    'affid',
    'sub1',
    'sub2',
    'sub3',
    'sub4',
    'sub5',
    'oid',
  ];
  trackingKeys.forEach((key) => destination.searchParams.delete(key));

  const linkData: Record<string, unknown> = {
    image_hash: args.imageHash,
    link: destination.toString(),
    message: args.primaryText,
    name: args.headline,
  };

  if (description) {
    linkData.description = description;
  }
  if (args.ctaType) {
    linkData.call_to_action = { type: args.ctaType };
  }

  const creativeFields: Record<string, string> = {
    name: args.name,
    object_story_spec: JSON.stringify({ page_id: pageId, link_data: linkData }),
  };
  if (urlTags) {
    creativeFields.url_tags = urlTags;
  }

  const body = new URLSearchParams(creativeFields);
  const payload = await request<{ id?: string }>(`${accountId}/adcreatives`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!payload.id) {
    throw new MetaApiError('Meta returned no ad creative ID.');
  }
  return payload.id;
};

export const createPausedMetaAd = async (args: {
  adAccountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
}) => {
  const accountId = normalizeAdAccountId(args.adAccountId);
  const adSetId = assertGraphId(args.adSetId, 'Meta ad set ID');
  const creativeId = assertGraphId(args.creativeId, 'Meta ad creative ID');
  const body = new URLSearchParams({
    name: args.name,
    adset_id: adSetId,
    creative: JSON.stringify({ creative_id: creativeId }),
    status: 'PAUSED',
  });

  const payload = await request<{ id?: string }>(`${accountId}/ads`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!payload.id) {
    throw new MetaApiError('Meta returned no ad ID.');
  }
  return payload.id;
};
