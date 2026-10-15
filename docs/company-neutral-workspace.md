# Company-neutral workspace

The visible workspace name is Tax Marketing Studio. The repository, domain, OAuth configuration,
operator allowlist, provider configuration and storage destinations retain their existing identities.

## New work

- The company profile begins without a company identity, services/offers, differentiators, proof,
  contacts, approved claims, logo, colors or fonts. Generic tax audience, tone and compliance
  guidance remains and is explicitly distinguished from company facts.
- New browser keys hold the profile, remembered portfolio/review/video/layout sources and landing draft.
  Old browser values are neither migrated automatically nor deleted. Explicit saved links still reopen
  their existing records; legacy company-profile claim versions remain readable.
- A logo is optional. A configured invalid logo still raises an error rather than being ignored.
- People defaults to 50%, and reference-library use defaults to On. Supply approved people and select
  layouts in Reference Library, or choose 0% people and Library Off for prompt-only work.
- Layout selection is explicit and browser-local, capped at 50 references. Newly saved layout uploads
  are selected; removing a reference also removes its local selection. Selecting does not copy assets.
- Every new admission freezes `companySourceScope` (including requests from older clients). New
  jobs use only its selected library IDs, supplied video-bound human options, explicit selected Proof,
  and approved Proof exactly linked to the supplied video. They do not retrieve general shared Proof
  or the global human catalog automatically. Planner checkpoints bind to the frozen scope.
- Historical saved requests without this scope retain their original retrieval behavior and inputs.
  Opening/resuming an old portfolio is an explicit historical operation, not a fresh company draft.
- Prompt rules use supplied company identity and evidence. If absent, concepts stay unbranded;
  no company name, logo, contact detail, offer, testimonial or outcome may be invented.

## Existing data and access limits

All stored media, source videos, case studies, approved-human records, creative images, copy and
provenance remain in place. There is no archive, deletion, rewrite or migration. Internal source-role
identifiers such as `TRA_VIDEO` and `approved-tra-human` remain unchanged for compatibility.

This is still a trusted-operator shared workspace. Server libraries, Proof, media and saved creatives
are not partitioned by company or tenant; other existing records may remain visible and accessible
to the same authorized operators. Browser-local selection and a fresh profile are not access control.
Independent tax-company customer onboarding requires a separate tenancy/access-isolation design.
Do not represent this change as providing that isolation or silently reuse historical portfolios for
a different advertiser. No production data exclusion or archive operation is included.

The deferred six-ad repair work is outside this change. No paid execution or production release is
authorized by this PR.
