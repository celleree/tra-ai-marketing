# TRA AI Marketing — Active Image Workflow

## Status

This is the active implementation scope for the current TRA AI Marketing phase.

For now, focus only on the static-image creative workflow. Do not implement Claude ad-account management, autonomous Meta decisions, budget optimization, automatic pause/scale behavior, performance dashboards, or autonomous publishing unless explicitly reactivated by a later project decision.

The current creative pipeline is:

`User/Kinetiq inputs -> GPT-5.6 Sol creative planning/prompting -> GPT Image 2 generation -> user edit/regenerate -> save to TRA Creatives`

There is no separate AI QA/reviewer pass in the current workflow. Keep deterministic technical/compliance safeguards where practical.

## Source roles

The Create flow must support multiple explicitly typed source assets.

### TRA Video

May supply:
- people/human identity;
- messaging/captions;
- visual context;
- frames used as approved human references.

### TRA Reference

TRA-owned image or creative.

May supply:
- people/human identity;
- TRA-owned imagery;
- messaging;
- visual context.

### Layout Reference

Third-party or external static ad used only as a design blueprint.

May influence:
- layout;
- hierarchy;
- spacing;
- composition;
- text density;
- image/text balance;
- CTA placement;
- visual mechanism;
- typography feel;
- image treatment.

Must never supply:
- the reference advertiser's person/model;
- logo;
- branding;
- copy;
- claims;
- trademarks.

## Human-source invariant

When a generated creative contains a human:

- the human must come from an uploaded TRA Video or TRA Reference;
- never use the human from a Layout Reference;
- never invent a pure AI spokesperson/person as a substitute;
- if no approved TRA human source is available, choose a non-human concept instead;
- retain source provenance so each human-containing creative can be traced to its approved TRA source.

This is a hard product requirement.

## Reference preprocessing

The three source roles do not all flow into final image generation in the same way.

### Layout-reference analysis

A `LAYOUT_REFERENCE` or external Reference Library ad is analysis-only source material. Its raw pixels may be inspected by a layout-analysis step, but must not be attached to final image generation as content source pixels when those pixels could carry a third-party person/model or other prohibited content.

Planned architecture:

`LAYOUT_REFERENCE -> low-cost vision/layout analyzer -> cached LayoutBlueprint -> GPT-5.6 Sol creative planning -> image generation`

The layout analyzer should have a narrow job: identify what the design is doing. Prefer a lower-cost vision-capable model with low reasoning and strict structured output unless testing shows a stronger model is necessary.

A `LayoutBlueprint` should describe reusable design mechanisms such as:
- overall composition;
- subject/person placeholder location without identity;
- image/text split;
- headline location and hierarchy;
- CTA placement/treatment;
- whitespace;
- card/overlay positioning;
- geometric/background mechanisms;
- typography feel/hierarchy;
- text density;
- image/photography/illustration treatment;
- spacing/alignment.

It must not carry third-party person identity, logo/branding, exact copy, trademarks, unsupported claims, or other unapproved content downstream.

Analyze each unchanged layout reference once and cache/reuse the blueprint by media identity and/or content hash where practical.

Detailed deferred work is tracked in GitHub Issue #27.

### TRA-video preprocessing

A raw `TRA_VIDEO` is an approved source that may eventually supply a human, but raw video should not be treated as though its human pixels have already reached an image-only generation provider.

Planned architecture:

`TRA_VIDEO -> trusted video probe/validation -> stored approved video -> frame extraction -> representative approved frames -> Sol creative planning / image generation`

Future video preprocessing should preserve:
- frame timestamp;
- source-video identity/provenance;
- approved-human eligibility;
- reusable/cached representative frames.

Do not assume every frame should be persisted. Prefer a bounded representative set once frame-selection criteria are defined. Subtitle/caption extraction may be added later if it materially improves creative planning.

Detailed deferred work is tracked in GitHub Issue #28.

These preprocessing systems are separate:
- `TRA_VIDEO -> approved human/reference frames`;
- `LAYOUT_REFERENCE -> LayoutBlueprint`.

Sol later combines approved TRA context, approved TRA source material, layout instructions, user direction, and variation requirements. The layout analyzer is not a second creative planner.

## Company and brand grounding

Sol must receive the relevant approved TRA context automatically rather than relying only on logo/colors/fonts.

Canonical project context includes:
- `knowledge/tra-knowledge-base.md`;
- `knowledge/tra-brand-guidelines.md`;
- `knowledge/tra-guardrails-summary.md` plus the approved full guardrails source when exact compliance/disclaimer wording is required;
- `knowledge/customer-insights.md` where relevant;
- current Company Profile/runtime data when it is more current than static documentation.

Unsupported claims must remain unknown rather than being inferred.

The real TRA logo is the source of truth. Image models must not redraw it; reserve appropriate space and composite the approved logo deterministically.

## Variation planner

Sol should plan the batch before image generation.

Strategic dimensions can include:
- customer problem;
- desired outcome;
- objection;
- testimonial/proof when approved;
- statistics when approved;
- comparison when approved;
- price/offer positioning;
- feature-led angle;
- emotional angle;
- educational angle;
- aspirational/lifestyle angle;
- curiosity;
- urgency;
- before/after when supportable;
- customer persona;
- awareness stage;
- core message/hook;
- CTA/offer framing.

Execution dimensions can include:
- visual archetype;
- subject;
- environment;
- composition/layout;
- image treatment;
- photography/illustration treatment;
- text density;
- copy structure;
- image/text balance;
- graphic treatment;
- CTA treatment;
- typography hierarchy.

Use Meta/Andromeda-style creative diversification as the practical standard: concepts should represent materially different creative hypotheses, not headline swaps, recolors, person swaps, or minor rearrangements.

Nearby concepts should generally differ on at least:
- 1 strategic dimension; and
- 2 execution dimensions.

When the user requests fewer images, Sol should not take the first N matrix entries. It should select the highest-leverage set of distinct hypotheses available from the supplied TRA context, proof, source assets, and user direction. Until verified performance data exists, "highest leverage" means strongest strategically distinct hypotheses, not predicted winners.

## Format generation

A liked concept should support placement-specific variants:
- 9:16;
- 4:5;
- 1:1;
- horizontal only when needed.

Variants remain one concept family and should be recomposed for the target aspect ratio rather than naively cropped.

Preserve:
- concept identity;
- human source;
- message/hypothesis;
- logo handling;
- readable hierarchy;
- CTA readability.

## Library and editing

Accepted creatives must be savable to TRA Creatives.

Store enough information to retain:
- Creative ID;
- source provenance;
- layout reference provenance;
- creative fingerprint;
- generation brief/prompt metadata needed for reproduction;
- aspect-ratio family;
- parent/child lineage;
- edit history.

Editing must:
- start from the selected creative;
- accept plain-language instructions;
- preserve unrequested parts as much as practical;
- never replace the approved TRA human with an invented person or a Layout Reference person;
- preserve prior versions instead of overwriting them.

## Current release-gate checklist

The current image workflow is ready when all of the following work end-to-end:

- video upload;
- TRA reference upload;
- layout reference upload;
- layout reference produces an on-brand TRA adaptation;
- generated humans come only from TRA Video or TRA Reference sources;
- meaningful variation planning follows the strategic/execution matrix;
- small batches select the strongest distinct hypotheses;
- 9:16, 4:5, and 1:1 variants can be created from a liked concept;
- liked creatives can be saved to TRA Creatives;
- creatives can be edited;
- previous versions remain stored and traceable.

## Immediate implementation order

1. Multi-source media/input foundation: TRA Video, TRA Reference, Layout Reference, multiple assets, role-preserving request contract.
2. Company-profile/Sol context contract.
3. Reference preprocessing foundations: layout-reference -> cached `LayoutBlueprint` and TRA-video -> approved representative frames, without duplicating Sol's planning responsibility.
4. Variation planner and small-batch selection.
5. Placement-aware format generation.
6. Save-to-library provenance/metadata.
7. Editing and version history.
8. Production hardening for this workflow.

Do not skip to later items while the source-role contract is unresolved. In particular, Issue #26 should establish only the safe source/media foundation; do not pull Issue #27 layout analysis or Issue #28 video frame extraction into that branch.
