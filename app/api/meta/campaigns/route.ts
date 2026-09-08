import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { listMetaCampaigns, MetaApiError } from '@/lib/meta/client';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  try {
    const adAccountId = new URL(request.url).searchParams.get('adAccountId') || '';
    if (!adAccountId) {
      return NextResponse.json({ error: 'adAccountId is required.' }, { status: 400 });
    }
    return NextResponse.json({ items: await listMetaCampaigns(adAccountId) });
  } catch (error) {
    const message = error instanceof MetaApiError ? error.message : 'Failed to load Meta campaigns.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
