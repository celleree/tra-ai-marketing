import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireOperatorAccess } from '@/lib/auth/require-operator';
import { addProofRecords, listProofRecords, updateProofRecord } from '@/lib/proof/storage';
import type { ProofRecord, ProofStatus } from '@/lib/proof/types';
import {
  isProofId,
  parseCaseStudyProofDraft,
  parseReviewProofDraft,
} from '@/lib/proof/validation';

export const runtime = 'nodejs';

const REVIEW_KEYS = ['type', 'originalReviewText', 'source', 'attribution', 'rating', 'tags'];
const CASE_STUDY_KEYS = [
  'type',
  'title',
  'verifiedFacts',
  'approvedClaimWording',
  'sourceNote',
  'usageRestrictions',
  'requiredDisclaimer',
  'tags',
];
const CREATE_KEYS = ['items'];
const UPDATE_KEYS = ['id', 'expectedUpdatedAt', 'status', 'item'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const parseDraft = (value: unknown) => {
  if (!isRecord(value)) return null;
  if (value.type === 'review' && hasOnly(value, REVIEW_KEYS)) {
    const draft = parseReviewProofDraft(value);
    return draft ? ({ type: 'review', ...draft } as const) : null;
  }
  if (value.type === 'case-study' && hasOnly(value, CASE_STUDY_KEYS)) {
    const draft = parseCaseStudyProofDraft(value);
    return draft ? ({ type: 'case-study', ...draft } as const) : null;
  }
  return null;
};

const requestBody = async (request: Request) => {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
};

const proofId = () => `proof_${randomUUID().replaceAll('-', '')}`;
const nextTimestamp = (current?: string) =>
  new Date(Math.max(Date.now(), current ? Date.parse(current) + 1 : 0)).toISOString();

export async function GET() {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  try {
    return NextResponse.json({ items: await listProofRecords() });
  } catch (error) {
    console.error('Could not load Proof Library', error);
    return NextResponse.json({ error: 'Proof Library could not be loaded.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  const body = await requestBody(request);
  if (
    !body ||
    !hasOnly(body, CREATE_KEYS) ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 100
  ) {
    return NextResponse.json({ error: 'Add between 1 and 100 proof records.' }, { status: 400 });
  }
  const drafts = body.items.map(parseDraft);
  if (drafts.some((draft) => !draft)) {
    return NextResponse.json({ error: 'One or more proof records were invalid.' }, { status: 400 });
  }
  const timestamp = nextTimestamp();
  const records = drafts.map((draft): ProofRecord => ({
    ...draft!,
    id: proofId(),
    tags: draft!.tags ?? [],
    status: 'ACTIVE',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  try {
    return NextResponse.json({ items: await addProofRecords(records) }, { status: 201 });
  } catch (error) {
    console.error('Could not add Proof Library records', error);
    return NextResponse.json({ error: 'Proof records could not be added.' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;
  const body = await requestBody(request);
  const id = body?.id;
  const expectedUpdatedAt = body?.expectedUpdatedAt;
  const status = body?.status;
  const draft = parseDraft(body?.item);
  if (
    !body ||
    !hasOnly(body, UPDATE_KEYS) ||
    !isProofId(id) ||
    !isIsoDate(expectedUpdatedAt) ||
    (status !== 'ACTIVE' && status !== 'INACTIVE') ||
    !draft
  ) {
    return NextResponse.json({ error: 'Proof record update was invalid.' }, { status: 400 });
  }

  try {
    const current = (await listProofRecords()).find((record) => record.id === id);
    if (!current) return NextResponse.json({ error: 'Proof record was not found.' }, { status: 404 });
    const updated: ProofRecord = {
      ...draft,
      id,
      tags: draft.tags ?? [],
      status: status as ProofStatus,
      createdAt: current.createdAt,
      updatedAt: nextTimestamp(current.updatedAt),
    };
    const saved = await updateProofRecord(updated, expectedUpdatedAt);
    if (!saved) return NextResponse.json({ error: 'Proof record was not found.' }, { status: 404 });
    return NextResponse.json({ item: saved });
  } catch (error) {
    const conflict = error instanceof Error && error.message.includes('changed before this update');
    if (!conflict) console.error('Could not update Proof Library record', error);
    return NextResponse.json(
      { error: conflict ? 'Proof record changed. Reload it and try again.' : 'Proof record could not be updated.' },
      { status: conflict ? 409 : 500 }
    );
  }
}
