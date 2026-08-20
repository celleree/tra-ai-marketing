# Send to Meta — one-click MVP

## Purpose

Turn selected generated TRA creatives into a complete, reviewable Meta Ads Manager structure with minimal user input.

After one-time setup, the intended flow is:

`generate creatives -> select creatives -> Send to Meta -> create new PAUSED campaign -> create new PAUSED ad set -> create one PAUSED ad per creative -> show Meta IDs/results`

The user should be able to open Ads Manager immediately afterward and see the campaign, ad set, images, primary text, headlines, descriptions, CTAs, and destination URL already populated.

## One-time browser setup

The generated-results UI stores non-secret defaults in browser localStorage:
- default Meta ad account
- default Facebook Page
- destination URL (a website or externally hosted form URL)
- daily budget that would apply if the ad set were later activated

The Meta access token remains server-side in `META_ACCESS_TOKEN`; it is never stored in localStorage or returned to the browser.

## Automatic MVP campaign/ad-set policy

This version intentionally uses a deterministic automatic policy so the one-click flow is predictable and easy to verify in Ads Manager. A later performance-aware agent can replace this policy without changing the publishing surface.

Each send creates:

### Campaign
- objective: `OUTCOME_TRAFFIC`
- buying type: `AUCTION`
- special ad categories: none
- status: `PAUSED`
- ad-set budget sharing: disabled

### Ad set
- status: `PAUSED`
- optimization goal: `LANDING_PAGE_VIEWS`
- billing event: `IMPRESSIONS`
- bid strategy: `LOWEST_COST_WITHOUT_CAP`
- destination type: `WEBSITE`
- daily budget: saved one-time default, represented in the ad account's minor currency units
- broad US targeting, ages 25–65
- placements are left to Meta's automatic/default delivery behavior rather than manually constraining placements
- `is_dynamic_creative=false`

For this MVP, every generated concept is created as a separate ad. That makes the generated image/copy pairs easy to inspect and later measure individually. Dynamic/multi-asset creative selection can be added after the basic create-and-review loop is proven.

## Automatic ad content

Each generated creative already carries:
- internal creative ID
- R2-backed image/media ID
- creative category
- creative format
- primary text
- headline
- description

The publishing route:
1. reads the generated image bytes from existing media storage
2. uploads the image to Meta
3. creates a Meta ad creative with the generated primary text, headline, description, Page identity, destination URL, and CTA
4. creates the final ad as `PAUSED`

CTA is chosen automatically from the generated copy:
- `APPLY_NOW` when the copy explicitly centers on applying/application language
- `CONTACT_US` when the copy centers on contacting, calling, speaking, or consulting
- otherwise `LEARN_MORE`

## Safety boundary

The system may create new Meta objects, but it never activates them automatically.

This MVP may:
- create a new PAUSED campaign
- create a new PAUSED ad set with a configured budget/bidding/targeting policy
- upload generated images
- create new ad creatives
- create new ads as PAUSED

It does not:
- activate campaigns, ad sets, or ads
- modify budgets or bids on existing campaigns/ad sets
- edit existing campaigns/ad sets
- pause or delete existing ads
- change existing targeting
- spend money without a later explicit Meta-side activation

The budget on a newly created ad set is therefore configuration only until a human activates that structure in Meta Ads Manager.

## Meta API shape

The integration is isolated in `lib/meta/client.ts`.

It uses:
- `/me/adaccounts` to list accessible ad accounts
- `/me/accounts` to list Facebook Pages available to the token
- `/{ad-account}/campaigns` to create the PAUSED campaign
- `/{ad-account}/adsets` to create the PAUSED ad set
- `/{ad-account}/adimages` to upload generated images
- `/{ad-account}/adcreatives` to create link/image ad creatives
- `/{ad-account}/ads` to create the final PAUSED ads

Existing campaign/ad-set listing endpoints remain available for diagnostics and future support for choosing an existing structure.

The Graph/Marketing API version is configurable with `META_GRAPH_API_VERSION` and defaults to `v25.0`.

## Required server secret

`META_ACCESS_TOKEN`

Do not expose this token to the browser and do not commit it to the repository.

For preview testing, store `META_ACCESS_TOKEN` in the Vercel Preview environment and create a fresh preview deployment after adding or changing the value so the deployment receives the updated secret.

For the demo account, the token must belong to a Meta user/system user with access to the chosen ad account and Page and with the permissions needed for the operations above. The practical permission set remains centered on `ads_management` plus Page/business asset access required by the selected identity.

## Partial failure behavior

Campaign and ad-set creation happen once per selected batch. Ads are then processed one creative at a time.

A failure for one ad does not discard successful ads. Each creative result returns:
- TRA creative ID
- success/failed status
- Meta image hash when successful
- Meta creative ID when successful
- Meta ad ID when successful
- selected CTA when successful
- `PAUSED` ad status when successful
- error message when failed

The batch response also returns the new Meta campaign ID and ad-set ID.

Successfully created ads are deselected. Failed creatives remain selected so they can be retried.

## Naming

Campaign:

`TRA AI | Creative Batch | [UTC timestamp]`

Ad set:

`TRA AI | Broad US | Landing Page Views | [UTC timestamp]`

Ads:

`TRA | AI | [category label] | [format label] | [creative ID]`

## Known MVP limits

- This version creates a Traffic/Landing Page Views structure because a website/form URL can be configured without requiring a Meta Pixel or Meta Instant Form ID.
- Native Meta lead-form campaigns require additional Page/form selection and lead-generation-specific promoted-object/creative fields; add those after the basic one-click creation flow is verified.
- The automatic campaign/ad-set policy is a safe deterministic MVP policy, not yet a performance-aware media-buyer agent.
- Meta IDs/statuses are shown in the current generated-results session; there is not yet a persistent TRA creative-history database.
- Facebook Page identity is supported first. If an Instagram placement requires an explicit Instagram identity, add that identity to the same Meta service.
