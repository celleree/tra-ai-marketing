import { NextResponse } from 'next/server';
import {
  listMetaPages,
  listMetaPromotablePages,
  MetaApiError,
} from '@/lib/meta/client';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const adAccountId = url.searchParams.get('adAccountId')?.trim() || '';
    const items = adAccountId
      ? await listMetaPromotablePages(adAccountId)
      : await listMetaPages();
    return NextResponse.json({ items });
  } catch (error) {
    const message =
      error instanceof MetaApiError
        ? error.message
        : 'Failed to load Facebook Pages.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
