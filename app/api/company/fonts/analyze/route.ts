import { NextResponse } from 'next/server';
import { getMediaStorage } from '@/lib/media/local-storage';

export const runtime = 'nodejs';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const SAFE_MEDIA_ID = /^media_[a-f0-9]{32}$/;

const extractOutputText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'output_text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text.trim();
      }
    }
  }
  return '';
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { mediaId?: unknown };
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : '';
    if (!SAFE_MEDIA_ID.test(mediaId)) {
      return NextResponse.json({ error: 'Invalid font specimen.' }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OpenAI is not configured.' }, { status: 503 });
    }

    const specimen = await getMediaStorage().readImageById(mediaId);
    if (!specimen) {
      return NextResponse.json({ error: 'Font specimen not found.' }, { status: 404 });
    }

    const imageUrl = `data:${specimen.mimeType};base64,${specimen.buffer.toString('base64')}`;
    const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra',
        store: false,
        input: [
          {
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: 'Describe the visible typography style in this font specimen for use as design guidance. Focus on letterform character, weight, width, geometry, contrast, friendliness/formality, and best headline/body usage. Do not identify a font unless the exact identity is visually certain. Return one concise paragraph under 80 words.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Analyze this approved brand font specimen.' },
              { type: 'input_image', image_url: imageUrl, detail: 'high' },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: 'The font style could not be analyzed.' },
        { status: 502 }
      );
    }

    const description = extractOutputText(await response.json());
    if (!description) {
      return NextResponse.json(
        { error: 'The font style could not be analyzed.' },
        { status: 502 }
      );
    }

    return NextResponse.json({ description: description.slice(0, 500) });
  } catch (error) {
    console.error('Font specimen analysis failed', error);
    return NextResponse.json(
      { error: 'The font style could not be analyzed.' },
      { status: 500 }
    );
  }
}
