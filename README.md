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

The first application layer is now scaffolded with Next.js + TypeScript.

Implemented:
- one-page creative generator shell
- PNG/JPEG/WebP source image upload
- 10 MB default upload limit
- server-side MIME and file-signature validation
- server-generated safe filenames
- local media storage behind a storage interface
- uploaded-image preview route
- context input and variation-count controls

Next:
- image analysis
- TRA creative brief generation
- source-image-capable image generation
- multiple visual variations
- Meta copy generation
- lightweight creative QA

See `docs/creative-workflow-architecture.md` for the implementation plan.

## Local Development

Requirements:
- Node.js 22

Install and run:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Optional local settings can be copied from `.env.example`. By default, uploaded source images are written to `data/uploads/`, which is ignored by git.

Useful checks:

```bash
npm run typecheck
npm run build
```

## Repository Structure

- `app/` - Next.js pages and API routes
- `components/creative-generator/` - source upload and generation UI
- `lib/media/` - upload validation and storage abstraction
- `docs/knowledge-base/` - TRA brand, offer, compliance, and messaging source material
- `prompts/` - reusable AI workflows and prompt templates
- `references/ads/` - curated creative examples and notes
- `assets/brand/` - approved logos and brand assets
- `docs/` - implementation notes and roadmap

## Current Priority

Finish the image-first creative workflow before adding Meta automation.
