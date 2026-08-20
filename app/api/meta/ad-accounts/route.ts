import { NextResponse } from 'next/server';
import { listMetaAdAccounts, MetaApiError } from '@/lib/meta/client';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({ items: await listMetaAdAccounts() });
  } catch (error) {
    const message = error instanceof MetaApiError ? error.message : 'Failed to load Meta ad accounts.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
