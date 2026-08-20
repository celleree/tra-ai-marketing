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

## Creative App Status

The first working image-first creative workflow is implemented with Next.js + TypeScript.

Implemented:
- one-page creative generator
- PNG/JPEG/WebP source image upload with a 10 MB default limit
- direct browser-to-Cloudflare-R2 production uploads using short-lived presigned URLs
- local development upload fallback
- server-side file-signature validation after upload
- persistent R2 media storage in production
- context input and variation-count controls
- 15 canonical messaging categories as the primary creative-diversity system
- 5 simplified presentation formats selected automatically underneath the categories
- GPT-5.6 Terra reference-creative analysis before generation
- GPT-5.6 Terra Meta ad copy generation
- source-image-conditioned GPT Image 2 generation
- generated image + copy result cards labeled by category and format
- TRA claim/testimonial/statistic guardrails in the generation prompt

Generation flow:

`uploaded image -> GPT-5.6 Terra analysis -> category-led creative plan -> presentation format -> GPT-5.6 Terra copy -> GPT Image 2 image variations -> R2 -> results`

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
- `components/creative-generator/` - source upload, generation, and result UI
- `lib/media/` - upload validation and storage abstraction
- `lib/ai/` - AI-provider integration
- `lib/creatives/` - creative planning and result contracts
- `docs/creative-categories.md` - canonical 15 messaging categories
- `docs/knowledge-base/` - TRA brand, offer, compliance, customer, and messaging source material
- `prompts/` - reusable AI workflows and prompt templates
- `references/ads/` - curated creative examples and notes
- `assets/brand/` - approved logos and brand assets
- `docs/` - implementation notes and roadmap

## Current Priority

Test and harden the image-first creative workflow, then add deeper QA and Meta performance data.
