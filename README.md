# TRA AI Marketing System

A vendor-neutral workspace for building AI-assisted Meta advertising workflows for Tax Relief Advocates (TRA).

## Goals

- Generate high volumes of strong, meaningfully diverse static Facebook and Instagram ad concepts across different hooks, angles, formats, layouts, visual styles, and messaging approaches.
- Analyze Meta performance data and return clear, actionable insights.
- Turn strong source ads and visual ideas into original TRA-specific concepts and variations.
- Build a reusable TRA knowledge base for brand, copy, compliance, and campaign context.
- Keep the system portable so the AI layer can move between ChatGPT, Claude, or other models later.

## Build Phases

1. Foundation and TRA knowledge base
2. Static creative workflow
3. Quality-control rules
4. Meta data connection
5. Media-buyer assistant
6. Scale, automation, and future integrations

## Branch and Deployment Rule

**Feature branches = temporary isolated work / preview deployments.**

**`staging` = the complete, combined future version of the TRA app.**

**`main` = the current live production version of the TRA app.**

Normal feature work should branch from the latest `staging`, not from `main`. Completed feature branches should merge back into `staging` so the staging preview always represents the combined future version of the app. `main` may intentionally remain behind while future work is being assembled and tested.

Feature-branch deployments are temporary previews only. Do not manually promote them to production. Production should deploy from `main` only, and `staging` should move into `main` only when the combined future version is explicitly approved for release.

If `staging` changes while a feature branch is still being worked on, sync the feature branch with the latest `staging` before the final merge when needed. If branches touch the same files, resolve conflicts by preserving the intended work from both branches rather than silently replacing another agent's changes.

See `AGENTS.md` for the mandatory AI-agent workflow rules.

## Creative App Status

The working static-creative workflow is implemented with Next.js + TypeScript.

Implemented:
- one-page creative generator
- PNG/JPEG/WebP source image upload with a 10 MB default limit
- direct browser-to-Cloudflare-R2 production uploads using short-lived presigned URLs
- local development upload fallback
- server-side file-signature validation after upload
- persistent R2 media storage in production
- context input and variation-count controls
- upload-mode toggle for `TRA ad` versus `Reference ad`
- persistent reference-image library in R2, organized into the 15 canonical creative categories
- 15 canonical messaging categories as the primary creative-diversity system
- 5 simplified presentation formats selected automatically underneath the categories
- GPT-5.6 Terra source/reference analysis before generation
- GPT-5.6 Terra Meta ad copy generation
- GPT Image 2 source/reference-conditioned generation
- generated image + copy result cards labeled by category and format
- TRA claim/testimonial/statistic guardrails in the generation prompt

Generation modes:

**TRA ad mode**

`uploaded TRA ad (brand/content anchor) + category-matched reference-library ad (creative-execution anchor) -> analysis + category-led creative plan -> copy -> new TRA image -> R2 -> results`

The uploaded TRA ad establishes the advertiser and useful TRA brand/content cues. The reference library supplies fresh layout, composition, visual mechanism, and presentation inspiration. The output must be a new TRA ad rather than a minor edit of the uploaded TRA ad.

**Reference ad mode**

`uploaded reference ad -> dominant-category analysis -> TRA adaptation within that category -> copy -> new TRA image -> R2 -> results`

The uploaded reference is creative inspiration rather than the advertiser identity. Its dominant angle/category is detected once and the generated variations normally stay within that angle while being converted into original TRA ads.

**No-image mode**

`user context -> category-led creative plan -> copy -> original TRA images -> R2 -> results`

Still to build:
- deeper creative QA and scoring
- richer TRA brand/offer/compliance knowledge retrieval
- generation history/library
- Meta performance data connection
- media-buyer assistant workflows

See `docs/creative-workflow-architecture.md` for the implementation plan and `docs/r2-browser-upload.md` for the production R2 CORS requirement.

## Local Development

Requirements:
- Node.js 22

Install and run:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Copy `.env.example` for local settings. Local uploads are written to `data/uploads/`, which is ignored by git. Creative generation requires `OPENAI_API_KEY`.

Useful checks:

```bash
npm run typecheck
npm run build
```

## Production Configuration

Required server-only environment variables:
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `OPENAI_API_KEY`

Optional model overrides:
- `OPENAI_ANALYSIS_MODEL` (defaults to `gpt-5.6-terra`)
- `OPENAI_TEXT_MODEL` (defaults to `gpt-5.6-terra`)
- `OPENAI_IMAGE_MODEL` (defaults to `gpt-image-2`)

One OpenAI API key is used for all three model calls. The key is not model-specific.

The R2 bucket also needs a CORS policy allowing PUT requests from the live app origin. See `docs/r2-browser-upload.md`.

## Repository Structure

- `app/` - Next.js pages and API routes
- `components/creative-generator/` - source upload, mode selection, generation, and result UI
- `components/reference-library/` - reference-image library UI
- `lib/media/` - upload validation and R2/local storage abstraction
- `lib/references/` - reference-library metadata and storage
- `lib/ai/` - AI-provider integration
- `lib/creatives/` - creative planning and result contracts
- `docs/creative-categories.md` - canonical 15 messaging categories
- `docs/knowledge-base/` - TRA brand, offer, compliance, customer, and messaging source material
- `prompts/` - reusable AI workflows and prompt templates
- `references/ads/` - curated repository reference notes
- `assets/brand/` - approved logos and brand assets
- `docs/` - implementation notes and roadmap

## Current Priority

Test and harden the reference-library-driven static creative workflow, then add deeper QA and Meta performance data.
