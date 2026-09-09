import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { listMetaAdAccounts, MetaApiError } from '@/lib/meta/client';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  try {
    return NextResponse.json({ items: await listMetaAdAccounts() });
  } catch (error) {
    const message = error instanceof MetaApiError ? error.message : 'Failed to load Meta ad accounts.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
