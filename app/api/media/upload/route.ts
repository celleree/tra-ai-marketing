import { NextResponse } from 'next/server';
import { getMediaStorage } from '@/lib/media/local-storage';
import { validateSourceRoleForMime } from '@/lib/media/source-contract';
import { MediaValidationError } from '@/lib/media/storage';
import { requireOperatorAccess } from '@/lib/auth/require-operator';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const sourceRoleValue = formData.get('sourceRole');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Choose a file to upload.' },
        { status: 400 }
      );
    }

    const sourceContract = validateSourceRoleForMime(
      sourceRoleValue,
      file.type
    );
    if (!sourceContract.success) {
      return NextResponse.json(
        { error: sourceContract.error },
        { status: 400 }
      );
    }

    const media = await getMediaStorage().saveMedia(file);
    return NextResponse.json(
      {
        ...media,
        ...(sourceContract.data.role
          ? { sourceRole: sourceContract.data.role }
          : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof MediaValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Media upload failed', error);
    return NextResponse.json(
      { error: 'The file could not be uploaded.' },
      { status: 500 }
    );
  }
}
