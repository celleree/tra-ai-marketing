import { NextResponse } from 'next/server';
import {
  buildCreativeFormatPlan,
  validateGenerateCreativeRequest,
} from '@/lib/creatives/generate-request';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = validateGenerateCreativeRequest(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const formatPlan = buildCreativeFormatPlan(parsed.data);

    return NextResponse.json({
      status: 'accepted',
      message:
        'Creative format plan created. Image and copy generation will use this plan in the next step.',
      request: parsed.data,
      formatPlan,
    });
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON request body' },
      { status: 400 }
    );
  }
}
