import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { ReferenceLibraryItem } from '@/lib/references/types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_REFERENCE_CANDIDATES = 40;

export interface ReferenceSelectionCandidate {
  item: ReferenceLibraryItem;
  imageUrl: string;
}

export interface SelectedReferenceCreative extends ReferenceSelectionCandidate {
  selectionReason: string;
}

const getApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  return apiKey;
};

const getErrorMessage = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message || `OpenAI request failed with ${response.status}.`;
  } catch {
    return `OpenAI request failed with ${response.status}.`;
  }
};

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
        return (part as { text: string }).text;
      }
    }
  }

  return '';
};

const referenceImageDataUrl = async (candidate: ReferenceSelectionCandidate) => {
  const stored = await getMediaStorage().readImageById(candidate.item.id);
  if (!stored) {
    throw new Error(
      `Reference ${candidate.item.id} could not be loaded from media storage.`
    );
  }

  return `data:${stored.mimeType};base64,${stored.buffer.toString('base64')}`;
};

const newestFirst = (a: ReferenceSelectionCandidate, b: ReferenceSelectionCandidate) =>
  new Date(b.item.addedAt).getTime() - new Date(a.item.addedAt).getTime();

const buildCandidatePool = (candidates: ReferenceSelectionCandidate[]) => {
  if (candidates.length <= MAX_REFERENCE_CANDIDATES) return [...candidates];

  const byAngle = new Map<string, ReferenceSelectionCandidate[]>();
  for (const candidate of candidates) {
    const group = byAngle.get(candidate.item.angle) || [];
    group.push(candidate);
    byAngle.set(candidate.item.angle, group);
  }
  for (const group of byAngle.values()) group.sort(newestFirst);

  const groups = Array.from(byAngle.values());
  const pool: ReferenceSelectionCandidate[] = [];
  let round = 0;

  while (pool.length < MAX_REFERENCE_CANDIDATES) {
    let added = false;
    for (const group of groups) {
      const candidate = group[round];
      if (!candidate) continue;
      pool.push(candidate);
      added = true;
      if (pool.length >= MAX_REFERENCE_CANDIDATES) break;
    }
    if (!added) break;
    round += 1;
  }

  return pool;
};

const SELECTION_RULES = `
You are selecting individual reference ads for Tax Relief Advocates (TRA) creative generation.

CRITICAL WORKFLOW RULE:
- Each generated TRA creative will use exactly ONE selected reference image.
- References will NEVER be blended together.
- Select the best individual references so each can be recreated separately as a clean TRA adaptation.

Selection priorities, in order:
1. Fit with the user's requested direction and the TRA brand/message context.
2. A clear single creative idea with strong hierarchy and an easy-to-understand composition.
3. A layout and visual mechanism that can be cleanly adapted to TRA without copying third-party branding, people, claims, testimonials, or trademarks.
4. Prefer polished, simple, intentional ads over cluttered collages, busy multi-concept layouts, or visually confusing references.
5. When quality is similar, prefer variety across visual structures and angles so the requested batch is not repetitive.

Do not select the same reference more than once.
Do not invent reference IDs.
Return exactly the requested number of selections.
`;

export async function selectBestReferenceCreatives(args: {
  candidates: ReferenceSelectionCandidate[];
  requestedCount: number;
  userContext: string;
  traSummary: string;
  traPreserve: string[];
}): Promise<SelectedReferenceCreative[]> {
  if (args.requestedCount < 1) return [];
  if (args.candidates.length < args.requestedCount) {
    throw new Error(
      `Only ${args.candidates.length} reference image${args.candidates.length === 1 ? '' : 's'} are available for ${args.requestedCount} requested creatives.`
    );
  }

  const pool = buildCandidatePool(args.candidates);
  if (pool.length < args.requestedCount) {
    throw new Error('There are not enough reference images to create this batch.');
  }

  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: `Choose exactly ${args.requestedCount} reference images for separate TRA recreations.\n\nUser direction:\n${args.userContext}\n\nTRA source summary:\n${args.traSummary}\n\nTRA identity/message cues:\n${args.traPreserve.join('; ') || 'Tax Relief Advocates identity'}\n\nReview every candidate below. Each candidate is labeled with its exact reference ID and current library category.`,
    },
  ];

  for (const candidate of pool) {
    userContent.push({
      type: 'input_text',
      text: `REFERENCE ID: ${candidate.item.id}\nLIBRARY CATEGORY: ${CREATIVE_CATEGORY_LABELS[candidate.item.angle]}`,
    });
    userContent.push({
      type: 'input_image',
      image_url: await referenceImageDataUrl(candidate),
      detail: 'low',
    });
  }

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: SELECTION_RULES }],
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'tra_reference_selection',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              selections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    referenceId: {
                      type: 'string',
                      enum: pool.map((candidate) => candidate.item.id),
                    },
                    reason: { type: 'string' },
                  },
                  required: ['referenceId', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['selections'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) throw new Error(await getErrorMessage(response));

  const text = extractOutputText(await response.json());
  if (!text) throw new Error('OpenAI returned no reference selection.');

  const parsed = JSON.parse(text) as {
    selections?: Array<{ referenceId?: string; reason?: string }>;
  };
  const byId = new Map(pool.map((candidate) => [candidate.item.id, candidate]));
  const used = new Set<string>();
  const selected: SelectedReferenceCreative[] = [];

  for (const item of parsed.selections || []) {
    if (!item.referenceId || used.has(item.referenceId)) continue;
    const candidate = byId.get(item.referenceId);
    if (!candidate) continue;
    used.add(item.referenceId);
    selected.push({
      ...candidate,
      selectionReason: item.reason?.trim() || 'Best fit for this TRA creative batch.',
    });
  }

  if (selected.length !== args.requestedCount) {
    throw new Error(
      `Reference selection returned ${selected.length} unique references for ${args.requestedCount} requested creatives.`
    );
  }

  return selected;
}
