import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import {
  CREATIVE_FORMAT_LABELS,
  CREATIVE_FORMATS,
} from '@/lib/creative-formats';

export async function GET() {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  return NextResponse.json({
    formats: CREATIVE_FORMATS.map((id) => ({
      id,
      label: CREATIVE_FORMAT_LABELS[id],
    })),
  });
}
