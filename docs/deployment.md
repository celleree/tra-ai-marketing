# Deployment

This file contains only setup requirements that live outside application code.

## Vercel

- Production deploys from `main`; `staging` is the combined pre-production branch and feature branches are temporary previews.
- Configure the server-side environment variables listed in `.env.example` in the appropriate Vercel environments. Do not expose secrets through `NEXT_PUBLIC_*` variables.
- Authenticated application media paths use same-origin `/api/media/files/...` URLs. The app can use Vercel's `VERCEL_PROJECT_PRODUCTION_URL` system variable as a fallback when constructing canonical public attribution URLs; set `CREATIVE_PUBLIC_BASE_URL` when an explicit canonical origin is required.
- After changing environment variables, verify a fresh deployment receives the new values.

The connected Vercel account should be treated as the authority for actual project/domain/environment state; do not copy dashboard state into repository documentation.

Video intelligence requires the pinned FFmpeg binary installed by `postinstall` in the job, generation, and revision function bundles. The resumable job and selection routes need a 300-second function duration; each request performs a bounded unit and stores progress before the next browser request. Verify uploads, MP4 range playback, artifact persistence, and reload/resume on the intended deployment before treating the video workflow as production-ready.

### Production video configuration

Vercel Production and Preview require `NODE_ENV=production`. Conflicting or missing `NODE_ENV` is invalid deployment configuration, even when all credentials are present: protected application access fails with 503 before Clerk or request parsing; the video gate rejects it; media and durable video/quota factories refuse local fallback (including a cached media adapter); and legacy local-video helpers reject it. Fix the deployment configuration instead of enabling development fallbacks. This does not introduce a manual video feature flag.

There is no separate runtime feature flag for Production video. In Vercel **Production**, durable video availability is determined by the deployment environment and required configuration: `VERCEL_ENV=production` must be supplied by the platform, both Clerk keys must have Production markers (`pk_live_` / `sk_live_`), and the Clerk, OpenAI and four R2 variables must be nonblank. Missing or invalid required Production configuration keeps the video workflow unavailable. Local development and protected Preview retain their existing behavior. Legacy prototype video endpoints stay development-only.

This gate checks configuration presence and Clerk environment markers, not credential validity, key pairing, DNS/CORS, bucket privacy/scope or provider access. Verify those separately. Existing server operator authorization, durable quotas, source/provenance validation and persistence checks remain mandatory. Satisfying the configuration gate makes the Production video workflow available in that deployment; it does not authorize provider spend, promote a deployment, or certify final end-to-end release acceptance. Configure changes through a new approved deployment; do not promote an old Preview build with Preview credentials.

## Cloudflare R2

Production media storage requires the R2 variables listed in `.env.example`.

Direct browser uploads and downloads use short-lived presigned URLs. The production bucket must have a CORS policy that:

- allows only the exact approved application origins that need browser media access;
- allows `GET` and `PUT`;
- allows the `Content-Type` request header;
- may expose `ETag` when needed by the client;
- does not use a wildcard production origin.

Preview origins should be added only when those previews need direct media access. R2 credentials remain server-side.

Cloudflare configuration is authoritative for the live bucket. Keep this document to requirements, not copied account IDs, credentials, or dashboard snapshots.

## Clerk authentication

The approved application-authentication provider is Clerk, using email one-time-code sign-in and invite-only access. Initial operators are the exact addresses in `lib/auth/operators.ts`; do not grant whole-domain access or normalize mailbox aliases. The backup operator uses the same verified-email/session requirements as the primary account.

Configure Clerk's **Invite-only** access mode (`restricted`) and email verification-code sign-in; disable password, social, and other sign-in methods. Clerk's separate dashboard allowlist applies to Open mode, so it does not replace invite-only signup. Server authorization must independently check the verified primary email against TRA's operator policy.

Use separate development/Preview and Production Clerk instances and scoped environment values. Both Clerk environment variables are required for session handling. The `/studio` layout and every application API handler require a signed-in operator with an approved verified primary email, including private media and font delivery. Missing configuration fails closed: Studio shows authentication is unavailable and protected APIs return 503. The public landing page remains accessible.

Before production release, verify invitation enrollment, email-code sign-in, operator access, and signed-out API rejection on the intended deployment. Invitation links must target that environment's `/sign-up` page; direct signup without an invitation must remain blocked. Provisioning authentication does not remove the video workflow's separate deployment-availability gates. Production configuration and deployment still require explicit approval.

See [Clerk access restrictions](https://clerk.com/docs/guides/secure/restricting-access) and [email verification-code options](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options).

## OpenAI

- Store `OPENAI_API_KEY` server-side.
- Model override variable names and current defaults are defined by `.env.example` and source code.

### Image admission, durable recovery and usage events

Server-only image authorization and purpose are independent; `.env.example` documents their exact values. Keep local/Preview offline unless a paid run is explicitly authorized. Diagnostics use LOW Sunburst and no fallback; staging smoke and production use HIGH. Deployed production keeps its existing admission. Review and smoke approval are operational gates, not a browser-selectable override.

Paid image attempts and raw results use the existing environment-isolated video-intelligence storage with conditional writes. Configure staging R2 access before authorizing spend. Unknown provider outcomes are retained and never automatically repurchased; missing/corrupt purchased results fail closed. Local storage ownership is process-local; deployed ownership relies on R2 conditional writes. This does not promise exactly-once provider billing.

Server logs emit `tra_provider_usage` events with allowlisted metadata and a versioned estimate. Count unique dispatched attempt IDs, not start/terminal log lines; `reused` events add no request or cost. A missing terminal event or usage category is unknown, never free. Keep unknown-cost attempts separate from known estimates and reconcile provider billing independently. `confirmedBilledCostUsd` is not populated from estimates. Model/tier prices and supported categories are centralized in `lib/ai/provider-pricing.ts`; update that version/source when rates change. Do not retain prompts, pixels, transcripts or credentials in usage exports.

Browser recovery requires session storage and retains only a request digest and UUID in the current tab. Retry or refresh keeps an unresolved paid intent; completing it or choosing an explicit new paid action permits fresh work. Do not clear session storage during recovery. Review the offline corpus in `tests/fixtures/cost-regression-corpus.md`; actual creative quality and cost per accepted output require a separately authorized staging run and human review.

## Meta

- Store `META_ACCESS_TOKEN` server-side.
- The token/user or system user must have access to the selected ad account and Facebook Page plus the permissions required by the implemented publishing flow.
- Meta API version and URL-tag overrides are configured through the variables defined in `.env.example`.
- Runtime publishing behavior, targeting, tracking defaults, naming, and safety restrictions are defined in `lib/meta/` and the Meta API routes, not duplicated here.

## Verification

Before production release, verify the deployment builds successfully, required environment variables are present in the intended environment, R2 uploads work from approved origins, and any external OpenAI/Meta credentials have the intended least-privilege access. For stored media, verify the authenticated `/api/media/files/...` request returns a `307` redirect and the browser then receives the actual media bytes directly from Cloudflare R2 with a successful response.
