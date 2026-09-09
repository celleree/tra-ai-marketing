import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { analyzeCompanyWebsite } from '@/lib/company/website-analyzer';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);

  try {
    const body = (await request.json()) as { websiteUrl?: unknown };
    const websiteUrl = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : '';

    if (!websiteUrl) {
      return NextResponse.json({ error: 'Website URL is required.' }, { status: 400 });
    }
    const quotaDenied = await requireOperatorQuota(access.userId, 'WEBSITE_ANALYSIS', 1);
    if (quotaDenied) return quotaDenied;

    const analysis = await analyzeCompanyWebsite(websiteUrl);
    return NextResponse.json(analysis);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Website analysis failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
