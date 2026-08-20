# TRA Creative Workflow Architecture

## Goal

Build a focused TRA static-creative system that can:

1. Accept an optional uploaded image and explicit instructions.
2. Let the user identify the upload as either a `TRA ad` or a `Reference ad`.
3. Generate multiple original TRA static ads with Meta copy.
4. Use the 15 canonical categories to create meaningful creative diversity.
5. Use the persistent reference library as creative inspiration when a TRA ad is uploaded.
6. Run lightweight QA before showing results.

The workflow remains image-first. Video support can enter later by extracting useful source frames without changing the core creative pipeline.

## Architecture choice

Use a small full-stack **Next.js + TypeScript** application in this repository.

Why:
- one codebase for the UI and API
- simple deployment on Vercel
- direct browser-to-R2 uploads for media
- server-side access to persistent R2 media and reference metadata
- straightforward AI/image-provider integration

## Source roles

The two upload modes deliberately give uploaded images different jobs.

### TRA ad mode

The uploaded image is the **TRA brand/content anchor**.

Use it for:
- advertiser identity
- TRA logo/company-name treatment when visible
- useful brand colors and visual identity cues
- service/message context
- approved offer/CTA cues that are actually visible or supplied

Do **not** use it as the required composition template.

For every planned variation, the generator selects a usable item from the persistent reference library. It prefers a reference in the same canonical creative category and avoids reusing the same reference until needed.

The selected reference is the **creative-execution anchor**.

Use it for:
- layout logic
- composition
- visual hierarchy
- spacing and rhythm
- presentation mechanism
- high-level design treatment

Do not transfer third-party brand names, logos, trademarks, people, exact wording, testimonials, statistics, results, or unsupported claims from the reference.

Pipeline:

```text
Uploaded TRA ad
    ↓
TRA brand/content analysis (once per batch)
    +
15-category creative plan
    +
Reference library selection per variation
    ↓
TRA copy per category
    ↓
GPT Image receives:
  image 1 = TRA brand/content anchor
  image 2 = library creative-execution anchor
    ↓
NEW TRA ad
    ↓
R2 + results
```

The output must be meaningfully different from the uploaded TRA ad. Recoloring, moving one text block, swapping one photograph, or changing only a headline does not count as a distinct creative.

### Reference ad mode

The uploaded image is **creative inspiration**, not the advertiser identity.

The source analysis also classifies the reference into one dominant canonical category. The batch normally stays inside that category while producing original TRA adaptations of the concept.

Pipeline:

```text
Uploaded reference ad
    ↓
Reference analysis + dominant category (one analysis call)
    ↓
Same-category TRA variation plan
    ↓
TRA copy
    ↓
GPT Image receives the uploaded reference
    ↓
Original TRA adaptations
    ↓
R2 + results
```

This mode does not need to pull extra reference-library images because the uploaded image itself is already the creative reference.

### No-image mode

If no image is uploaded, the system can still create original TRA ads from the user's text direction.

```text
User context
    ↓
15-category creative plan
    ↓
TRA copy
    ↓
Original image generation
    ↓
R2 + results
```

## Creative diversity

The canonical categories describe **what the ad is saying** and remain the primary diversity system. See `docs/creative-categories.md`.

Formats describe **how the ad is presented** and remain intentionally simpler. See `docs/knowledge-base/creative-formats.md`.

For TRA ad mode:
- rotate through categories for broad messaging diversity
- prefer a library reference from the same category
- avoid repeating a reference until necessary
- if the matching folder has no unused reference, use another unused library item for visual execution while keeping the planned category as the messaging direction

For Reference ad mode:
- detect one dominant category from the uploaded reference
- keep the batch within that category by default
- allow multiple original executions without pretending they are different marketing angles

## Reference library and R2

The reference-image library is implemented and persistent.

Production reference images use the same R2-backed media storage as other uploaded/generated media. Reference metadata is stored in R2 at:

`_metadata/reference-library.json`

Each library item records its canonical creative category. The generation endpoint reads this index server-side, selects references, then reads the chosen image objects from R2. No additional browser CORS permissions are required for these server-side reads.

Direct browser uploads still use short-lived presigned PUT URLs and the CORS policy documented in `docs/r2-browser-upload.md`.

## Copy generation

For each planned creative, produce:
- Meta primary text
- headline
- optional description
- CTA recommendation when applicable

Copy uses the assigned canonical category as the main messaging direction. The user's context is direction, not proof of claims.

## Guardrails

Do not fabricate:
- testimonials or review quotes
- statistics or percentages
- dollar amounts or customer results
- expert endorsements
- government affiliation
- competitor claims
- guarantees

Do not imply universal tax-debt results. Do not import unsupported claims or identity elements from reference ads.

## QA direction

Continue hardening checks for:
- unsupported claims
- incorrect or unapproved offer language
- spelling/grammar problems
- generic AI language
- duplicate or near-duplicate concepts
- brand mismatch
- missing required disclaimer when applicable

QA should return warnings rather than silently rewriting important claims.

## Not building in this step

- social scheduling/publishing
- full Meta campaign management
- full Postiz editor
- Stripe/billing
- account/team system
- video transcription pipeline
- autonomous media buying

## Video-ready extension

Later, video can enter by converting it into useful source frames:

```text
Uploaded video
    ↓
Sample/extract frames
    ↓
Select useful visual source
    ↓
Existing TRA/reference upload modes
    ↓
Creative generation pipeline
```

## Definition of done

A TRA marketer can:
- upload an existing TRA ad, mark it as `TRA ad`, and receive genuinely new TRA ads driven by the reference library across multiple categories
- upload an outside/example ad, mark it as `Reference ad`, and receive original TRA adaptations that stay within the reference's main angle
- generate from text alone when no image is needed
- receive generated image ads plus Meta copy without using any Publish Everywhere scheduling or publishing functionality
