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
3. Variation planner and small-batch selection.
4. Placement-aware format generation.
5. Save-to-library provenance/metadata.
6. Editing and version history.
7. Production hardening for this workflow.

Do not skip to later items while the source-role contract is unresolved.
