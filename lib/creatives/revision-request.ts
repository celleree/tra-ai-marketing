import { normalizeRuntimeCompanyProfile, type RuntimeCompanyProfileSnapshot } from '@/lib/company/creative-context';
import { isCreativePlacement, type CreativePlacement } from '@/lib/creatives/placements';

type CompanyContext = { companyProfile?: RuntimeCompanyProfileSnapshot };

// The selected parent ID comes from the route, never from caller-supplied identity metadata.
export type CreativeRevisionRequest = CompanyContext & (
  | { operation: 'EDIT' | 'VARIATION'; instruction: string }
  | { operation: 'REGENERATE' }
  | { operation: 'PLACEMENT'; placement: CreativePlacement }
);

export function validateCreativeRevisionRequest(input: unknown):
  | { success: true; data: CreativeRevisionRequest }
  | { success: false; error: string } {
  const invalid = (error: string) => ({ success: false as const, error });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('Revision request must be a JSON object.');
  }
  const body = input as Record<string, unknown>;
  const operation = body.operation;
  if (operation !== 'EDIT' && operation !== 'VARIATION' && operation !== 'REGENERATE' && operation !== 'PLACEMENT') {
    return invalid('Choose edit, variation, regeneration, or a placement variant.');
  }
  const keys = ['operation', 'companyProfile', ...(operation === 'PLACEMENT' ? ['placement'] : operation === 'REGENERATE' ? [] : ['instruction'])];
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    return invalid('Revision request contains fields that do not apply to this operation.');
  }
  if (body.companyProfile != null && (typeof body.companyProfile !== 'object' || Array.isArray(body.companyProfile))) {
    return invalid('Company profile must be a JSON object.');
  }
  const companyProfile = normalizeRuntimeCompanyProfile(body.companyProfile);
  const context = companyProfile ? { companyProfile } : {};
  if (operation === 'PLACEMENT') {
    if (!isCreativePlacement(body.placement)) return invalid('Choose a supported target image shape.');
    return { success: true, data: { operation, placement: body.placement, ...context } };
  }
  if (operation === 'REGENERATE') return { success: true, data: { operation, ...context } };
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction || instruction.length > 4000) {
    return invalid('Describe the requested change in 1 to 4000 characters.');
  }
  return { success: true, data: { operation, instruction, ...context } };
}
