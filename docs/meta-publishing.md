# Send to Meta — first version

## Purpose

Extend the generated-static-creative workflow so selected TRA creatives can be created in an existing Meta ad set without manual download/upload/copy-paste work.

Flow:

`generate creatives -> select creatives -> Send to Meta -> choose account/campaign/ad set/Page -> create one Meta ad per creative as PAUSED -> show per-creative result`

## Safety boundary

This first version may only create new ads and always sends `status=PAUSED` when creating the ad.

It does not:
- activate or publish ads
- change campaign budgets
- change ad set budgets
- change bid strategies
- pause existing ads
- delete ads
- edit existing campaigns or ad sets

## Existing TRA data reused

Each generated creative already carries:
- internal creative ID
- R2-backed image/media ID
- creative category
- creative format
- primary text
- headline
- description

The Meta publishing route reads the generated image from the existing media-storage abstraction and uploads those same bytes to the Meta ad account. No second media-storage system is introduced.

## Meta API shape

The integration is isolated in `lib/meta/client.ts`.

The first version uses:
- `/me/adaccounts` to list accessible ad accounts
- `/{ad-account}/campaigns` to list existing campaigns
- `/{campaign}/adsets` to list existing ad sets
- `/me/accounts` to list Facebook Pages available to the token
- `/{ad-account}/adimages` to upload generated images
- `/{ad-account}/adcreatives` to create link/image ad creatives
- `/{ad-account}/ads` to create the final ads with `status=PAUSED`

The Graph/Marketing API version is configurable with `META_GRAPH_API_VERSION` and defaults to `v25.0`, the current version when this feature was implemented in August 2026.

## Required server secret

`META_ACCESS_TOKEN`

Do not expose this token to the browser and do not commit it to the repository.

For preview testing, store `META_ACCESS_TOKEN` in the Vercel Preview environment and create a fresh preview deployment after adding or changing the value so the deployment receives the updated secret.

For the demo account, the token must belong to a Meta user/system user with access to the chosen ad account and Page and with the permissions needed for the operations above. The practical first-version permission set is:
- `ads_management` for creating ad images, creatives, and ads
- `pages_show_list` for listing Pages available to the token
- `pages_manage_ads` for creating ads/creatives tied to the selected Facebook Page
- `ads_read` may also be requested for read-only advertising access; `ads_management` is still required for creation
- `business_management` is only needed when the selected Business Manager/system-user setup requires business-asset access; do not require it globally when the demo account does not need it
- `pages_read_engagement` is not required by this first-version workflow unless we later read or reuse existing Page posts/content

Use Meta's Access Token Debugger / Business settings to verify the token's scopes and asset access. User access tokens expire; for a durable internal integration, move to the appropriate Business Manager system-user/token setup once TRA's real Meta Business is connected.

## Partial failure behavior

Publishing is intentionally processed one creative at a time. A failure for one creative does not roll back or mark the entire batch failed.

Each result returns:
- TRA creative ID
- success/failed status
- Meta image hash when successful
- Meta creative ID when successful
- Meta ad ID when successful
- `PAUSED` ad status when successful
- error message when failed

After a batch, successfully created ads are deselected and failed creatives remain selected so they can be retried without intentionally duplicating successful ads.

## Naming

The first version names ads using:

`TRA | AI | [category label] | [format label] | [creative ID]`

This is generated server-side and can be changed later without changing the Meta client architecture.

## Known first-version limits

- Meta IDs/statuses are shown in the current generated-results session; there is not yet a persistent TRA creative-history database.
- The selected existing ad set controls budget, targeting, optimization, placements, and bid strategy. This feature does not modify those settings.
- Facebook Page identity is supported first. If a particular Instagram placement/ad set requires an explicit Instagram identity, add that identity selection to the same Meta service rather than changing the creative-generation flow.
- The final end-to-end verification requires a real Meta token, demo ad account, existing campaign/ad set, and Page.
