export const TRA_CAPABILITIES = [
  'shared:read',
  'copilot:use',
  'recommendations:manage',
  'recommendations:approve-generation-handoff',
  'creatives:generate',
  'creatives:approve',
  'intelligence:financial:read',
  'workspace:admin',
] as const;

export type TraCapability = (typeof TRA_CAPABILITIES)[number];
export type TraRole = 'marketing_user' | 'admin';

const MARKETING_USER_CAPABILITIES = Object.freeze([
  'shared:read',
  'copilot:use',
  'recommendations:manage',
  'recommendations:approve-generation-handoff',
  'creatives:generate',
  'creatives:approve',
] satisfies readonly TraCapability[]);

const ADMIN_CAPABILITIES = Object.freeze([
  ...MARKETING_USER_CAPABILITIES,
  'intelligence:financial:read',
  'workspace:admin',
] satisfies readonly TraCapability[]);

const ROLE_CAPABILITIES: Readonly<Record<TraRole, readonly TraCapability[]>> = Object.freeze({
  marketing_user: MARKETING_USER_CAPABILITIES,
  admin: ADMIN_CAPABILITIES,
});

export function capabilitiesForRole(role: TraRole): readonly TraCapability[] {
  return ROLE_CAPABILITIES[role];
}

export function roleHasCapability(role: TraRole, capability: TraCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Meta execution is deliberately absent. Adding any advertising mutation
 * capability requires a separate authorization and release decision.
 */
