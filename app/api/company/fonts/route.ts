import { NextResponse } from 'next/server';
import {
  BrandFontValidationError,
  saveBrandFont,
} from '@/lib/company/font-storage';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Choose a font file to upload.' }, { status: 400 });
    }

    return NextResponse.json(await saveBrandFont(file), { status: 201 });
  } catch (error) {
    if (error instanceof BrandFontValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Brand font upload failed', error);
    return NextResponse.json(
      { error: 'The font could not be uploaded.' },
      { status: 500 }
    );
  }
}
