# TRA AI Marketing — Active Image Workflow

## Status and authority

This document is the current implementation source of truth for the Stage 1 static-image workflow. When this file conflicts with future-role descriptions in `docs/roadmap.md`, use this file for current implementation work and treat the roadmap description as future direction unless a newer GitHub Issue explicitly changes the decision.

Current scope only: static-image creative generation and editing. Do not implement Claude ad-account management, autonomous Meta decisions, budget optimization, automatic pause/scale behavior, performance dashboards, or autonomous publishing unless explicitly reactivated.

The current creative pipeline is:

`User/Kinetiq inputs -> GPT-5.6 Sol creative planning/prompting -> GPT Image 2 generation -> user edit/regenerate -> save to TRA Creatives`

Claude is not currently required in the active image-generation path. The roadmap's Claude strategist/orchestrator role is future architecture to validate/reintroduce only when the project explicitly activates it.

There is no separate AI QA/reviewer pass in the current image workflow. Keep deterministic technical/compliance safeguards where practical.

## Source roles

The Create flow supports explicitly typed source assets.

### TRA Video

May supply people/human identity, messaging/captions, visual context, and approved human-reference frames.

### TRA Reference

TRA-owned image/creative. May supply people/human identity, TRA-owned imagery, messaging, and visual context.

### Layout Reference

Third-party/external ad used only as a design blueprint. It may influence layout, hierarchy, spacing, composition, text density, image/text balance, CTA placement, visual mechanism, typography feel, and image treatment.

It must never supply the external advertiser's person/model, logo, branding, copy, claims, or trademarks to final generation.

## Human-source invariant

When a generated creative contains a human:

- the human must come from an uploaded TRA Video or TRA Reference;
- never use a Layout Reference person;
- never invent a pure-AI spokesperson as a substitute;
- if no approved TRA human source is available, choose a non-human concept;
- retain source provenance to the approved TRA source.

This is a hard product requirement.

## Reference preprocessing

The source roles do not enter final generation in the same way.

### Layout references

A `LAYOUT_REFERENCE` or external Reference Library ad is analysis-only source material. Raw layout-reference pixels may be inspected by the layout-analysis step but must not become content-source pixels in final generation when they could carry third-party identity/content.

Current intended flow:

`LAYOUT_REFERENCE -> low-cost vision/layout analyzer -> cached LayoutBlueprint -> Sol planning -> image generation`

The analyzer has one narrow job: describe reusable design mechanisms. Prefer the cheapest vision-capable route that reliably returns the required structured blueprint.

The blueprint may contain composition, subject placeholder location without identity, image/text split, hierarchy, CTA treatment, whitespace, overlays, background/geometric mechanisms, typography feel, text density, image treatment, spacing, and alignment.

It must not carry third-party person identity, logo/branding, exact copy, trademarks, or unsupported claims downstream.

Cache/reuse unchanged layout analysis by media identity/content hash where practical.

### TRA video

The video preprocessing path is implemented locally through the merged video-intelligence/selection work. Do not rebuild it from the old deferred Issue #28 description.

Current flow:

`TRA_VIDEO -> validation/hydration -> candidate extraction -> technical grouping + transcript + visual observations -> source-bound frame library -> user selects 1-3 known representative frames -> fresh approved PNG extraction from original video -> Sol/image generation -> provenance saved with creative`

Current invariants:

- raw video is not itself an approved image-provider input;
- analysis candidates/thumbnails remain unverified and provider-ineligible;
- selected generation frames must be re-extracted as fresh approved PNGs from the original server-hydrated TRA video;
- selected frames retain source-video identity, source hash, candidate/frame identity, and timestamps;
- invalid, stale, mixed-source, or unknown selections fail before paid generation calls;
- the local video-intelligence prototype remains development-only unless production architecture is explicitly added later;
- unchanged source analysis should be cached/reused rather than repeating provider work.

The layout and video preprocessing systems remain separate:

- `TRA_VIDEO -> approved human/reference frames`;
- `LAYOUT_REFERENCE -> LayoutBlueprint`.

Sol combines approved TRA context, approved TRA source pixels, layout instructions, user direction, and variation requirements. The layout analyzer is not a second creative planner.

## Company and brand grounding

Sol must receive relevant approved TRA context automatically rather than relying only on logo/colors/fonts.

Canonical context includes:
- `knowledge/tra-knowledge-base.md`;
- `knowledge/tra-brand-guidelines.md`;
- `knowledge/tra-guardrails-summary.md` plus approved full guardrails when exact wording is required;
- `knowledge/customer-insights.md` when relevant;
- current Company Profile/runtime data when newer than static documentation.

Unsupported claims remain unknown rather than inferred.

The real TRA logo is the source of truth. Image models must not redraw it; reserve space and composite the approved logo deterministically.

## Variation planner

Sol plans the batch before image generation.

Strategic dimensions may include customer problem, desired outcome, objection, approved proof/statistics, comparison, price/offer positioning, feature-led angle, emotional/educational/aspirational/curiosity/urgency framing, before/after when supportable, persona, awareness stage, core message/hook, and CTA/offer framing.

Execution dimensions may include visual archetype, subject, environment, composition/layout, image treatment, photography/illustration treatment, text density, copy structure, image/text balance, graphic treatment, CTA treatment, and typography hierarchy.

Use Meta/Andromeda-style diversification as the practical standard: concepts should be materially different creative hypotheses, not headline swaps, recolors, person swaps, or minor rearrangements.

Nearby concepts should generally differ on at least:
- 1 strategic dimension; and
- 2 execution dimensions.

For small batches, select the strongest strategically distinct hypotheses available from supplied TRA context, proof, source assets, and user direction. Until verified performance data exists, this means strategic diversity/quality, not predicted winners.

## Format generation

A liked concept should support placement-specific variants:
- 9:16;
- 4:5;
- 1:1;
- horizontal only when needed.

Variants stay within one concept family and should be recomposed for the target aspect ratio rather than naively cropped.

Preserve concept identity, human source, message/hypothesis, logo handling, readable hierarchy, and CTA readability.

## Library and editing

Accepted creatives must be savable to TRA Creatives with enough information to retain:
- Creative ID;
- source and selected-frame provenance;
- layout-reference provenance;
- creative fingerprint;
- generation brief/prompt metadata needed for reproduction;
- aspect-ratio family;
- parent/child lineage;
- edit history.

Editing must start from the selected creative, accept plain-language instructions, preserve unrequested parts where practical, never replace an approved TRA human with an invented/Layout Reference person, and preserve previous versions instead of overwriting them.

## Current release gate

The current image workflow is ready when these work end-to-end:

- TRA Video, TRA Reference, and Layout Reference inputs;
- source roles remain separated and provenance is preserved;
- selected video frames can safely supply approved human pixels to generation;
- layout references produce on-brand TRA adaptations without carrying external identity/content;
- generated humans come only from TRA Video or TRA Reference;
- complete company/brand context reaches Sol;
- meaningful variation planning follows strategic/execution dimensions;
- small batches choose the strongest distinct hypotheses;
- 9:16, 4:5, and 1:1 variants can be created from a liked concept;
- liked creatives save to TRA Creatives with provenance/metadata;
- creatives can be edited while previous versions remain traceable.

## Immediate implementation order

Treat already-merged foundations as complete unless current code/tests show a regression. Do not reopen completed historical Issues merely because an older document still describes them as future work.

Remaining current priorities:

1. Complete company-profile/Sol context contract where gaps remain.
2. Complete layout-reference -> cached `LayoutBlueprint` behavior and downstream safety where gaps remain.
3. Complete variation planner and small-batch selection.
4. Complete placement-aware format generation.
5. Complete save-to-library provenance/metadata across all source paths.
6. Complete editing/version history.
7. Production hardening for the image workflow.

Use current GitHub Issues for exact acceptance criteria and completion state.