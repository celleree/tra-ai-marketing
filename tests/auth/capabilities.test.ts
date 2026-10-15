import { describe, expect, it } from 'vitest';
import { capabilitiesForRole, roleHasCapability, TRA_CAPABILITIES } from '@/lib/auth/capabilities';

describe('TRA auth capabilities', () => {
  it('keeps marketing users limited to current human-in-the-loop product actions', () => {
    expect(capabilitiesForRole('marketing_user')).toEqual([
      'shared:read',
      'copilot:use',
      'recommendations:manage',
      'recommendations:approve-generation-handoff',
      'creatives:generate',
      'creatives:approve',
    ]);
  });

  it('grants workspace administration and financial intelligence only to admins', () => {
    expect(roleHasCapability('marketing_user', 'workspace:admin')).toBe(false);
    expect(roleHasCapability('marketing_user', 'intelligence:financial:read')).toBe(false);
    expect(roleHasCapability('admin', 'workspace:admin')).toBe(true);
    expect(roleHasCapability('admin', 'intelligence:financial:read')).toBe(true);
  });

  it('does not define any Meta execution capability', () => {
    expect(TRA_CAPABILITIES.some((capability) => capability.startsWith('meta:'))).toBe(false);
  });
});
