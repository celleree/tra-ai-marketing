/** Exact approved operators. Do not expand to domains or mailbox aliases. */
export const TRA_OPERATOR_EMAILS = [
  'arundel.kramer@tra.com', // Primary operator.
  'christina@kinetiqmedia.com',
  'arundelkramer@gmail.com', // Backup; uses the same authentication requirements.
] as const;

export interface OperatorIdentity {
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification: { status: string } | null;
  }>;
}

/** Supply only a server-verified Clerk user, never request-body identity data. */
export const isAllowedTraOperator = (user: OperatorIdentity | null | undefined): boolean => {
  const primary = user?.emailAddresses.find((email) => email.id === user.primaryEmailAddressId);
  return Boolean(primary?.verification?.status === 'verified'
    && TRA_OPERATOR_EMAILS.some((email) => email === primary.emailAddress.trim().toLowerCase()));
};
