# TRA Creative Workflow — Initial Architecture

## Goal

Build the smallest useful TRA creative app:

1. Upload an image.
2. Add context/instructions.
3. Generate multiple image-ad variations.
4. Generate Meta ad copy alongside each variation.
5. Run lightweight QA before showing results.

The first version is intentionally image-first. Video support should fit later without changing the core workflow.

## Architecture choice

Use a small full-stack **Next.js + TypeScript** application in this repository.

Why:
- one codebase for the UI and API
- simple deployment
- easy file upload handling
- easy integration with AI/image providers
- no need to inherit the larger Postiz/Publish Everywhere monorepo

We can reuse the useful design patterns from Publish Everywhere while implementing the small pieces we need directly in this repo.

## Proposed repository structure

```text
tra-ai-marketing/
├── app/
│   ├── page.tsx                         # Initial creative generator page
│   └── api/
│       ├── media/
│       │   └── upload/route.ts          # Upload source image
│       └── creatives/
│           └── generate/route.ts        # Generate images + copy
│
├── components/
│   └── creative-generator/
│       ├── image-upload.tsx
│       ├── context-input.tsx
│       ├── generate-controls.tsx
│       └── creative-results.tsx
│
├── lib/
│   ├── media/
│   │   ├── storage.ts                   # Storage interface
│   │   ├── local-storage.ts             # Local development implementation
│   │   └── types.ts
│   │
│   ├── ai/
│   │   ├── image-analysis.ts            # Understand uploaded image
│   │   ├── creative-brief.ts            # Image + context + TRA knowledge
│   │   ├── image-generation.ts          # Image provider interface
│   │   ├── copy-generation.ts           # Meta copy generation
│   │   └── creative-qa.ts               # Lightweight output checks
│   │
│   └── tra/
│       └── knowledge-base.ts             # Reads approved TRA context
│
├── data/
│   ├── uploads/                          # Local source uploads; gitignored
│   └── generated/                        # Local generated assets; gitignored
│
├── docs/
│   └── knowledge-base/                   # Existing TRA knowledge base
│
├── prompts/                              # Existing reusable prompts
├── assets/brand/                         # Existing TRA brand assets
└── references/ads/                       # Existing curated references
```

## Endpoint 1: image upload

`POST /api/media/upload`

Input:
- multipart image file

Initial accepted types:
- PNG
- JPEG
- WebP

Output:

```json
{
  "id": "media_...",
  "fileName": "source.png",
  "mimeType": "image/png",
  "path": "/uploads/media_...png"
}
```

Rules:
- validate MIME type and file size
- generate our own safe file name
- never trust the uploaded file name as a storage path
- keep raw uploads out of git

The storage call sits behind an interface so local storage can later be replaced with R2/S3 without changing the generation route.

## Endpoint 2: generate creatives

`POST /api/creatives/generate`

Input:

```json
{
  "mediaId": "media_...",
  "context": "Adapt this concept into a TRA Facebook/Instagram tax-relief ad.",
  "variationCount": 4
}
```

Later inputs can include:
- selected TRA brand assets
- campaign objective
- audience
- offer
- aspect ratio
- specific knowledge-base sections

Output:

```json
{
  "creativeBrief": {},
  "creatives": [
    {
      "id": "creative_...",
      "imagePath": "/generated/creative_...png",
      "primaryText": "...",
      "headline": "...",
      "description": "...",
      "cta": "...",
      "qa": {
        "status": "pass",
        "warnings": []
      }
    }
  ]
}
```

## Generation pipeline

```text
Uploaded image
    ↓
Image analysis
    ↓
User context
    +
TRA knowledge base
    ↓
Creative brief
    ↓
Create N distinct concepts
    ↓
Generate N images
    +
Generate copy for each
    ↓
Lightweight QA
    ↓
Results grid
```

## Image analysis

Adapt the useful pattern already proven in Publish Everywhere:
- summarize what the image visibly contains
- identify concrete visual facts
- identify readable text when reliable
- identify unknowns instead of guessing
- identify the main creative idea

The analysis is an intermediate brief, not the final ad.

## Image generation

Do **not** bring over Publish Everywhere's current text-only image rendering implementation as the final solution.

Use a provider interface so the first working generator can be swapped later:

```ts
interface ImageGenerationProvider {
  generate(input: {
    sourceImagePath: string;
    prompt: string;
    aspectRatio: string;
  }): Promise<GeneratedImage>;
}
```

The provider should be capable of receiving the source/reference image when we implement the first real generator. This avoids the current Publish Everywhere limitation where the final renderer receives only text.

## Copy generation

For each visual concept, produce:
- Meta primary text
- headline
- optional description
- CTA recommendation

Copy must use the TRA knowledge base as the factual source of truth once populated.

## QA for version 1

Run simple deterministic/model checks for:
- unsupported claims
- incorrect or unapproved offer language
- spelling/grammar problems
- generic AI language
- obvious duplication between variations
- missing required disclaimer when applicable

QA returns warnings rather than silently changing important claims.

## What we are intentionally not building yet

- social scheduling/publishing
- Meta campaign management
- reference-image library/database
- full Postiz editor
- Stripe/billing
- account/team system
- video transcription pipeline
- background-job infrastructure
- autonomous media buying

## Video-ready extension

Later, video should enter the same pipeline by converting it into useful source frames:

```text
Uploaded video
    ↓
Sample/extract frames
    ↓
Select useful visual source
    ↓
Existing image analysis + creative generation pipeline
```

This means the image-first implementation does not need to be thrown away when video is added.

## Implementation order

1. Scaffold Next.js + TypeScript app.
2. Implement local storage abstraction.
3. Implement `/api/media/upload`.
4. Build upload + context UI.
5. Implement image analysis.
6. Implement creative brief contract.
7. Connect a source-image-capable image generation provider.
8. Generate multiple image variations.
9. Generate Meta copy for each variation.
10. Add lightweight QA and results grid.

## Definition of done for first working version

A TRA marketer can open one page, upload one image, add short context, choose a number of variations, click Generate, and receive multiple image ads plus Meta copy without using any Publish Everywhere scheduling or publishing functionality.
