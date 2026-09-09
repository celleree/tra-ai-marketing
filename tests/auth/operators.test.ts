import { describe, expect, it } from 'vitest';
import { isAllowedTraOperator, TRA_OPERATOR_EMAILS, type OperatorIdentity } from '@/lib/auth/operators';

const identity = (emailAddress: string, status = 'verified'): OperatorIdentity => ({
  primaryEmailAddressId: 'email-primary',
  emailAddresses: [{ id: 'email-primary', emailAddress, verification: { status } }],
});

describe('TRA operator policy', () => {
  it.each(TRA_OPERATOR_EMAILS)('allows the verified exact operator %s', (email) => {
    expect(isAllowedTraOperator(identity(email))).toBe(true);
    expect(isAllowedTraOperator(identity(email.toUpperCase()))).toBe(true);
  });

  it.each(['other@tra.com', 'other@kinetiqmedia.com', 'other@gmail.com',
    'arundelkramer+backup@gmail.com', 'arundel.kramer@gmail.com', 'arundel.kramer@tra.com.example'])
  ('does not extend access to domains or aliases: %s', (email) => {
    expect(isAllowedTraOperator(identity(email))).toBe(false);
  });

  it('requires a verified primary email for every operator, including the backup', () => {
    for (const email of TRA_OPERATOR_EMAILS) {
      expect(isAllowedTraOperator(identity(email, 'unverified'))).toBe(false);
      const user = identity(email);
      user.emailAddresses[0].verification = null;
      expect(isAllowedTraOperator(user)).toBe(false);
      user.primaryEmailAddressId = null;
      expect(isAllowedTraOperator(user)).toBe(false);
    }
    expect(isAllowedTraOperator(null)).toBe(false);
    expect(isAllowedTraOperator(undefined)).toBe(false);
  });

  it('does not authorize an allowed secondary email when the primary is not approved', () => {
    const user = identity('other@tra.com');
    user.emailAddresses.push({ id: 'email-secondary', emailAddress: TRA_OPERATOR_EMAILS[0], verification: { status: 'verified' } });
    expect(isAllowedTraOperator(user)).toBe(false);
  });
});
