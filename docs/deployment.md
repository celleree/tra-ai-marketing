# Deployment

This file contains only setup requirements that live outside application code.

## Vercel

- Production deploys from `main`; `staging` is the combined pre-production branch and feature branches are temporary previews.
- Configure the server-side environment variables listed in `.env.example` in the appropriate Vercel environments. Do not expose secrets through `NEXT_PUBLIC_*` variables.
- Authenticated application media paths use same-origin `/api/media/files/...` URLs. The app can use Vercel's `VERCEL_PROJECT_PRODUCTION_URL` system variable as a fallback when constructing canonical public attribution URLs; set `CREATIVE_PUBLIC_BASE_URL` when an explicit canonical origin is required.
- After changing environment variables, verify a fresh deployment receives the new values.

The connected Vercel account should be treated as the authority for actual project/domain/environment state; do not copy dashboard state into repository documentation.

Video intelligence requires the pinned FFmpeg binary installed by `postinstall` in the job, generation, and revision function bundles. The resumable job and selection routes need a 300-second function duration; each request performs a bounded unit and stores progress before the next browser request. Verify uploads, MP4 range playback, artifact persistence, and reload/resume on the intended deployment before treating the video workflow as production-ready.

## Cloudflare R2

Production media storage requires the R2 variables listed in `.env.example`.

Direct browser uploads use short-lived presigned PUT URLs. The production bucket must have a CORS policy that:

- allows only the exact approved application origins that need browser uploads;
- allows `PUT`;
- allows the `Content-Type` request header;
- may expose `ETag` when needed by the client;
- does not use a wildcard production origin.

Preview origins should be added only when those previews need direct uploads. R2 credentials remain server-side.

Cloudflare configuration is authoritative for the live bucket. Keep this document to requirements, not copied account IDs, credentials, or dashboard snapshots.

## Clerk authentication

The approved application-authentication provider is Clerk, using email one-time-code sign-in and invite-only access. Initial operators are the exact addresses in `lib/auth/operators.ts`; do not grant whole-domain access or normalize mailbox aliases. The backup operator uses the same verified-email/session requirements as the primary account.

Configure Clerk's **Invite-only** access mode (`restricted`) and email verification-code sign-in; disable password, social, and other sign-in methods. Clerk's separate dashboard allowlist applies to Open mode, so it does not replace invite-only signup. Server authorization must independently check the verified primary email against TRA's operator policy.

Use separate development/Preview and Production Clerk instances and scoped environment values. Provisioning, invitations, and authenticated access must be verified before enabling the route-protection layer. When both Clerk environment variables are present, the application starts Clerk session handling and the `/studio` layout admits only signed-in approved operators. Without both values, the app remains accessible for local work and auth pages show configuration is unavailable. API resource guards are a separate follow-up and are not yet enforced by this session-entry layer. Production configuration and deployment still require explicit approval.

See [Clerk access restrictions](https://clerk.com/docs/guides/secure/restricting-access) and [email verification-code options](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options).

## OpenAI

- Store `OPENAI_API_KEY` server-side.
- Model override variable names and current defaults are defined by `.env.example` and source code.

## Meta

- Store `META_ACCESS_TOKEN` server-side.
- The token/user or system user must have access to the selected ad account and Facebook Page plus the permissions required by the implemented publishing flow.
- Meta API version and URL-tag overrides are configured through the variables defined in `.env.example`.
- Runtime publishing behavior, targeting, tracking defaults, naming, and safety restrictions are defined in `lib/meta/` and the Meta API routes, not duplicated here.

## Verification

Before production release, verify the deployment builds successfully, required environment variables are present in the intended environment, R2 uploads work from approved origins, and any external OpenAI/Meta credentials have the intended least-privilege access.
