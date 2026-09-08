import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import {
  deleteBrandFont,
  readBrandFont,
} from '@/lib/company/font-storage';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileName: string }> }
) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  const { fileName } = await context.params;
  const stored = await readBrandFont(fileName);

  if (!stored) {
    return NextResponse.json({ error: 'Font not found.' }, { status: 404 });
  }

  return new Response(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': stored.mimeType,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ fileName: string }> }
) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  const { fileName } = await context.params;
  await deleteBrandFont(fileName);
  return NextResponse.json({ ok: true });
}
