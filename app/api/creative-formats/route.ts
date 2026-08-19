import { NextResponse } from 'next/server';
import {
  CREATIVE_FORMAT_LABELS,
  CREATIVE_FORMATS,
} from '@/lib/creative-formats';

export async function GET() {
  return NextResponse.json({
    formats: CREATIVE_FORMATS.map((id) => ({
      id,
      label: CREATIVE_FORMAT_LABELS[id],
    })),
  });
}
