import { NextResponse } from 'next/server';
import { listMetaPages, MetaApiError } from '@/lib/meta/client';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({ items: await listMetaPages() });
  } catch (error) {
    const message = error instanceof MetaApiError ? error.message : 'Failed to load Facebook Pages.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
