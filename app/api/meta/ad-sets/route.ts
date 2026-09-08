import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { listMetaAdSets, MetaApiError } from '@/lib/meta/client';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  try {
    const campaignId = new URL(request.url).searchParams.get('campaignId') || '';
    if (!campaignId) {
      return NextResponse.json({ error: 'campaignId is required.' }, { status: 400 });
    }
    return NextResponse.json({ items: await listMetaAdSets(campaignId) });
  } catch (error) {
    const message = error instanceof MetaApiError ? error.message : 'Failed to load Meta ad sets.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
