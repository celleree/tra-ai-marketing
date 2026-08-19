import { NextResponse } from 'next/server';
import { getMediaStorage } from '@/lib/media/local-storage';
import { MediaValidationError } from '@/lib/media/storage';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Choose an image to upload.' },
        { status: 400 }
      );
    }

    const media = await getMediaStorage().saveImage(file);
    return NextResponse.json(media, { status: 201 });
  } catch (error) {
    if (error instanceof MediaValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Image upload failed', error);
    return NextResponse.json(
      { error: 'The image could not be uploaded.' },
      { status: 500 }
    );
  }
}
