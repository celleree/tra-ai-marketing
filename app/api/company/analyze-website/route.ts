import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { analyzeCompanyWebsite } from '@/lib/company/website-analyzer';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  try {
    const body = (await request.json()) as { websiteUrl?: unknown };
    const websiteUrl = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : '';

    if (!websiteUrl) {
      return NextResponse.json({ error: 'Website URL is required.' }, { status: 400 });
    }

    const analysis = await analyzeCompanyWebsite(websiteUrl);
    return NextResponse.json(analysis);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Website analysis failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
