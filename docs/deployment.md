# Deployment

This file contains only setup requirements that live outside application code.

## Vercel

- Production deploys from `main`; `staging` is the combined pre-production branch and feature branches are temporary previews.
- Configure the server-side environment variables listed in `.env.example` in the appropriate Vercel environments. Do not expose secrets through `NEXT_PUBLIC_*` variables.
- The app can use Vercel's `VERCEL_PROJECT_PRODUCTION_URL` system variable as a fallback when constructing stable public creative URLs; set `CREATIVE_PUBLIC_BASE_URL` when an explicit canonical origin is required.
- After changing environment variables, verify a fresh deployment receives the new values.

The connected Vercel account should be treated as the authority for actual project/domain/environment state; do not copy dashboard state into repository documentation.

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
