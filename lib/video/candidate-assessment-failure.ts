/** Static diagnostics only: never persist provider bodies, prompts, URLs or exception messages. */
const codes = ['CONFIGURATION', 'IMAGE_ADMISSION', 'TRANSPORT', 'HTTP', 'RESPONSE_JSON',
  'RESPONSE_INCOMPLETE', 'REFUSAL', 'OUTPUT_MISSING', 'OUTPUT_JSON', 'ASSESSMENT_SHAPE',
  'ASSESSMENT_FIELD', 'OVERLAY_INVALID', 'UNKNOWN'] as const;
const fields = ['humanPresence', 'facialDetail', 'eyes', 'blur', 'occlusion',
  'expressionUsability', 'framing', 'observableReason'] as const;
export type CandidateAssessmentDiagnostic = { code: typeof codes[number]; field?: typeof fields[number]; httpStatus?: number };
export class CandidateAssessmentFailure extends Error {
  constructor(readonly diagnostic: CandidateAssessmentDiagnostic) { super(`Candidate assessment: ${diagnostic.code}`); }
}
export function parseCandidateAssessmentDiagnostic(value: unknown): CandidateAssessmentDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['code', 'field', 'httpStatus'].includes(key))
    || !codes.includes(item.code as never)
    || (item.field !== undefined && !fields.includes(item.field as never))
    || (item.httpStatus !== undefined && (!Number.isSafeInteger(item.httpStatus)
      || (item.httpStatus as number) < 100 || (item.httpStatus as number) > 599))) return null;
  return item as CandidateAssessmentDiagnostic;
}
export const candidateAssessmentDiagnostic = (error: unknown): CandidateAssessmentDiagnostic =>
  error instanceof CandidateAssessmentFailure
    ? parseCandidateAssessmentDiagnostic(error.diagnostic) ?? { code: 'UNKNOWN' } : { code: 'UNKNOWN' };
export const formatCandidateAssessmentDiagnostic = (diagnostic?: CandidateAssessmentDiagnostic): string => {
  const safe = parseCandidateAssessmentDiagnostic(diagnostic);
  return safe ? ` Assessment diagnostic: ${safe.code}${safe.field ? `/${safe.field}` : ''}${safe.httpStatus ? ` (HTTP ${safe.httpStatus})` : ''}.` : '';
};
