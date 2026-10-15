# TRA AI Marketing — Active Image Workflow

## Status and authority

This document is the current product-direction source of truth for the Stage 1 static-image workflow. Its purpose is to prevent older planning from being treated as current when agents or Codex read the repository.

Use this hierarchy when sources disagree:

1. Runtime code and tests define what is actually implemented now.
2. `docs/image-workflow.md` defines the active Stage 1 image-product direction and intended architecture.
3. GitHub Issues define task-specific implementation work and acceptance criteria underneath this direction. An Issue overrides this file only when it explicitly records a newer product decision and states what it supersedes.
4. `docs/architecture.md` defines stable system boundaries and future-stage architecture; it does not override the active Stage 1 image workflow.
5. `docs/roadmap.md` is long-term/future direction and does not override this file for active Stage 1 image work.

Do not reopen or restore older architecture merely because it still appears in a stale Issue, roadmap section, PR description, or historical planning note.

Current Stage 1 scope: static-image creative generation and editing. Do not implement Claude ad-account management, autonomous Meta decisions, budget optimization, automatic pause/scale behavior, performance dashboards, or autonomous publishing unless explicitly reactivated.

The [Create integration plan](tra-create-integration-plan.md) records newer target decisions: automatic Video Intelligence and Proof use from Create, the full selected human pool, and separate image/Meta copy. These supersede the earlier deferred/separate-step/three-frame target direction, not the description of current runtime behavior. Its A1 source packet is a type-only contract; integration and final staging verification remain pending.

The active target creative pipeline is:

`User/Kinetiq inputs -> GPT-6 Astra (medium reasoning) creative planning/prompting -> GPT Image 2.5 Sunburst generation/editing -> user review/select -> save to TRA Creatives`

GPT Image 2.5 Sunburst is the only user-facing image model and is preferred for every image-generation and revision operation. GPT Image 2.5 Flare is a hidden, single-attempt fallback only for compatible transient provider failures; successful fallback use must be recorded in provenance and surfaced to the user.

GPT-6 Astra is the current creative-planning/prompting model decision. When this path is wired through the OpenAI Responses API, use model `gpt-6-astra` with `reasoning.effort: medium`. Narrow preprocessing/analyzer tasks may continue to use cheaper models when they reliably satisfy their structured contract.

Claude is not currently required in the active image-generation path. Any roadmap or historical plan that assigns Claude a strategist/orchestrator role is future/deferred architecture unless this document or an explicit newer product-decision Issue reactivates it.

There is no separate AI QA/reviewer pass in the current image workflow. Keep deterministic technical/compliance safeguards where practical.

TRA Creatives supports plain-language edits, regeneration, meaningful variations and placement variants for saved generated creatives with complete identity/planning/source context. Each operation saves a new record and preserves prior versions. Legacy records without that context require a fresh saved generation; selected-video revisions require matching source-bound analysis in local development or protected Vercel Preview. Saving a version does not constitute human quality/compliance approval.

## Source roles

The Create flow supports multiple explicitly typed source assets in one request while preserving each asset's role.

### TRA Video

May supply people/human identity, messaging/captions, visual context, and approved human-reference frames.

### TRA Reference

TRA-owned image/creative. May supply people/human identity, TRA-owned imagery, messaging, and visual context.

### Layout Reference

Third-party/external ad used only as a design blueprint. It may influence layout, hierarchy, spacing, composition, text density, image/text balance, CTA placement, visual mechanism, typography feel, and image treatment.

It must never supply the external advertiser's person/model, logo, branding, copy, claims, or trademarks to final generation.

### Seeded tax-document references

User-provided tax-document exemplars are a separate document-structure source, not a Layout Reference, approved human source or factual evidence. Originals live in server-packaged `assets/tax-documents/`; their versioned IDs, SHA-256 hashes, original filenames, source and approved use live in `lib/references/tax-documents.ts`.

Astra selects `execution.taxDocumentReference` for notices or tax-mail envelopes only when needed by the concept. Generation and revisions automatically attach that seed with conditional document instructions; no repeat upload is needed. Existing saved plans without this field remain supported. Saved planning retains the ID and the actual render prompt retains its version/hash.

Use paper/envelope structure and physical construction only. Do not reproduce seals/logos, personal information, balances, SSNs, signatures, identifiers, source claims or pseudo-text. Sensitive fields stay blank; document wording must be explicitly planned. Document references do not grant human eligibility or advertising approval.

## Human-source invariant

When a generated creative contains a human:

- the human must come from an uploaded TRA Video or TRA Reference;
- never use a Layout Reference person;
- never invent a pure-AI spokesperson as a substitute;
- if no approved TRA human source is available, choose a non-human concept;
- retain source provenance to the approved TRA source.

This is a hard product requirement.

### Manual six-image render-test exception

The six-image Sunburst behavior-discovery experiment documented in `docs/image-gen-improvement.md` is a narrow manual test outside the app runtime. For that experiment only:

- when no approved TRA human source is supplied, Sunburst may generate an entirely fictional adult that does not copy or resemble a specific reference person;
- the assigned external layout-reference image may be attached directly to Sunburst as layout/structure inspiration only;
- third-party people/identity, branding, logos, exact copy, claims, prices, statistics, testimonials, and proof must not transfer into the TRA output;
- test output is not automatically approved for advertising use;
- these exceptions do not change current application/runtime source-role or human-source requirements.

Any production/runtime adoption of either exception requires a separate implementation change and verification after the manual experiment is reviewed.

## Reference preprocessing

The source roles do not enter final generation in the same way.

### Layout references

A `LAYOUT_REFERENCE` or external Reference Library ad is analysis-only source material. Raw layout-reference pixels may be inspected by the layout-analysis step but must not become content-source pixels in final generation when they could carry third-party identity/content.

Current intended flow:

`LAYOUT_REFERENCE -> low-cost vision/layout analyzer -> cached LayoutBlueprint -> GPT-6 Astra (medium) planning -> image generation`

The analyzer has one narrow job: describe reusable design mechanisms. Prefer the cheapest vision-capable route that reliably returns the required strict structured blueprint; do not use a stronger reasoning model unless testing shows it is necessary.

The blueprint may contain composition, subject placeholder location without identity, image/text split, hierarchy, CTA treatment, whitespace, overlays, background/geometric mechanisms, typography feel, text density, image treatment, spacing, and alignment.

It must not carry third-party person identity, logo/branding, exact copy, trademarks, or unsupported claims downstream.

Cache/reuse unchanged layout analysis by media identity/content hash where practical.

### TRA video

The video preprocessing/selection path uses resumable persisted jobs, cached source analysis and concept selection, and fresh selected PNG extraction. It is available in local development and protected Vercel Preview, using isolated private Preview storage. Production access remains gated pending application authorization and production hardening; deployed end-to-end verification is still required. Do not rebuild the completed extraction/selection foundation from old Issue #28 text.

Current implemented flow:

`TRA_VIDEO -> validation/hydration -> candidate extraction -> technical grouping + transcript + visual observations -> source-bound frame library -> user selects 1-3 known representative frames -> fresh approved PNG extraction from original video -> Astra/image generation -> provenance saved with creative`

The three-frame bound and separate Video Intelligence step above describe current implementation. The integration plan's B/C steps own automatic reuse and full-pool selection; A1 does not remove those limits or change paid-work retry behavior. Source readiness never approves evidence or human identity use.

Current invariants:

- raw video is not itself an approved image-provider input;
- analysis candidates/thumbnails remain unverified and provider-ineligible;
- selected generation frames must be re-extracted as fresh approved PNGs from the original server-hydrated TRA video;
- selected frames retain source-video identity, source hash, candidate/frame identity, and timestamps;
- invalid, stale, mixed-source, or unknown selections fail before paid generation calls;
- legacy prototype endpoints and local filesystem fallback remain development-only; Preview uses validated private persisted jobs and artifacts, with explicit retry after uncertain paid work;
- unchanged source analysis should be cached/reused rather than repeating provider work.

Automatic human-frame selection uses policy `human-frame-visual-quality-v2`. A cold decision sends every admitted, source-bound representative JPEG from the validated preparation bundle at `detail: high`; the 280px library thumbnail is not used as facial-quality evidence. The selector must assess every candidate, and application code rejects closed/blinking eyes, severe blur/occlusion, awkward expression geometry, insufficient facial detail, unusable framing, and source marks that cannot be removed by a bounded edge crop before ranking. Same-portfolio reuse is only a tiebreak among comparably suitable frames. The analysis JPEGs remain provider-ineligible and never become final generation inputs; selected IDs still require fresh approved-PNG extraction.

The image-provider boundary attaches the original extracted PNG only for an assessed clean frame. A removable edge overlay produces a pixel-only crop while retaining the original PNG and its hash; saved provenance records the crop and hash of the actual provider attachment separately. Unsafe or older unassessed human selections cannot reach image editing. The visual assessment can miss marks or misjudge a crop, so this safeguard does not certify every output as free of extra branding.

B1 video observations are search and planning evidence only; empty OCR/topics never authorize provider pixels. Explicit generation requires a v2 selection carrying visual-policy source-overlay decisions for the exact ordered frame IDs. Newly curated humans persist that decision in a v2 record; historical v1 records remain readable but require reassessment and reapproval before provider use. Previewing an original frame grants no such authorization.

The Responses API currently documents a 1,500-image and 512 MB request limit, with image tokens also counting against model context and TPM ([OpenAI image-input requirements](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)). The application never truncates the candidate pool: it rejects the whole decision with an actionable error above those provider limits or above its 240,000 estimated high-detail image-token cold-call budget. That guard estimates image input only; frame metadata, schema, instructions, and other input also count, and total input can change the applicable pricing tier. Reasoning and output costs are additional. One cold automatic decision remains one provider call; exact-policy warm cache reuse remains zero calls. Model overrides may have different pricing and must be measured separately.

The layout and video preprocessing systems remain separate:

- `TRA_VIDEO -> approved human/reference frames`;
- `LAYOUT_REFERENCE -> LayoutBlueprint`.

GPT-6 Astra combines approved TRA context, approved TRA source pixels, layout instructions, user direction, and variation requirements. The layout analyzer is not a second creative planner.

## Company and brand grounding

### Astra-to-renderer boundary

Astra receives broad approved company knowledge, user direction, source analysis and batch context. Initial generation and revisions render from the versioned one-ad contract in `lib/creatives/render-brief.ts`: exact planned copy/CTA, visual direction and execution, relevant brand styling, hard compliance rules and required disclaimers. A selected cached layout blueprint may supply geometry. Company summaries, service/proof catalogs, personas, batch selection reasons and raw user requests stay with planning.

Document rules remain conditional on a selected tax-document attachment. Human realism guidance applies only to approved-human photographic/documentary concepts. Edits carry their concrete visual instructions through Astra's revised `visualDirection`. Provider adapters retain placement, safe-zone, approved-source and deterministic-logo instructions; the saved actual prompt retains the complete rendered brief. This boundary does not itself approve copy or image quality for advertising.

GPT-6 Astra must receive relevant approved TRA context automatically rather than relying only on logo/colors/fonts.

Canonical context includes:
- `knowledge/tra-knowledge-base.md`;
- `knowledge/tra-brand-guidelines.md`;
- `knowledge/tra-guardrails-summary.md` plus approved full guardrails when exact wording is required;
- `knowledge/customer-insights.md` when relevant;
- current Company Profile/runtime data when newer than static documentation.

Unsupported claims remain unknown rather than inferred.

The real TRA logo is the source of truth. Image models must not redraw it; reserve space and composite the approved logo deterministically. Preserve its artwork, aspect ratio, colors, shapes, and spacing; proportional resizing is allowed.

## Variation planner

GPT-6 Astra plans the batch before image generation using medium reasoning.

For each strategic hypothesis, require a concise `SO WHAT?` outcome chain that connects the surface message to a functional consequence and then to a meaningful customer outcome. Use that chain to sharpen the concept rather than treating it as decorative metadata, and retain it with the creative's structured strategy metadata.

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

Each placement variant must respect its placement-safe zones so critical text, CTA content, the approved logo, faces, and other essential information are not obscured or cropped by platform UI. Safe zones are composition constraints, not decorative borders.

Stage 1 9:16 output targets Facebook and Instagram Stories only; Reels are outside this scope. For Stories images, reserve 14% at the top, 35% at the bottom and 6% on each side for platform overlays, following the [Facebook Stories](https://www.facebook.com/business/ads-guide/update/image/facebook-story) and [Instagram Stories](https://www.facebook.com/business/ads-guide/update/image/instagram-story) image guides verified on 2026-09-07. Place essential content and the deterministic original-logo overlay inside that area. Human review must confirm that the final content respects these boundaries; dimensions alone do not certify compliance.

## Quality and compliance release gate

The absence of a separate AI reviewer does not remove output-quality requirements. Reject/regenerate or clearly surface any creative with a material failure such as:

- obvious AI artifacts or implausible humans;
- malformed or unreadable text;
- awkward spacing, conflicting layout, clutter, or weak hierarchy;
- weak/irrelevant imagery or obvious brand mismatch;
- unsupported claims or missing required disclaimer;
- Layout Reference copying or third-party identity/branding transfer;
- near-duplicate concepts or insufficient dimensional change;
- placement/safe-zone failure;
- incorrect/redrawn TRA logo or no viable deterministic logo placement;
- output that would still require material designer cleanup before use.

Where practical, enforce hard compliance, source-role, identity, schema, logo, and placement/file rules deterministically rather than relying on model judgment.

## Library and editing

Accepted creatives must be savable to TRA Creatives with enough structured metadata to reconstruct the experiment and later connect performance/revenue to the exact creative. Retain, where applicable:

- concept-level Creative ID;
- per-format/media IDs;
- source type and source/reference identity;
- selected video-frame provenance and timestamps;
- layout-reference provenance;
- parent/child variation lineage;
- creative fingerprint;
- angle, persona, pain point, desired outcome, awareness stage, emotion, hook/message, offer/CTA dimensions;
- `SO WHAT?` outcome chain;
- visual direction and execution dimensions;
- requested/generated placements and aspect ratios;
- generation model/version and brief/prompt context needed for reproduction;
- QA/review results;
- approval/lifecycle state;
- later Meta IDs plus attribution/performance/revenue identity when those systems exist;
- edit/version history.

Rejected and paused creatives should remain available when practical as future learning data rather than being silently destroyed.

Editing must start from the selected creative, accept plain-language instructions, preserve unrequested parts where practical, never replace an approved TRA human with an invented/Layout Reference person, and preserve previous versions instead of overwriting them.

## Current release gate

The current image workflow is ready when these work end-to-end:

- TRA Video, TRA Reference, and Layout Reference inputs, including multiple typed assets where needed;
- source roles remain separated and provenance is preserved;
- selected video frames can safely supply approved human pixels to generation;
- layout references produce on-brand TRA adaptations without carrying external identity/content;
- generated humans come only from TRA Video or TRA Reference;
- complete company/brand context reaches GPT-6 Astra;
- GPT-6 Astra uses medium reasoning for creative planning/prompting;
- each strategic hypothesis has a retained `SO WHAT?` outcome chain;
- meaningful variation planning follows strategic/execution dimensions;
- small batches choose the strongest distinct hypotheses;
- quality/compliance failures above are rejected, regenerated, or clearly surfaced;
- 9:16, 4:5, and 1:1 variants can be created from a liked concept;
- placement variants preserve required safe zones for critical content;
- liked creatives save to TRA Creatives with provenance/metadata sufficient for future attribution;
- creatives can be edited while previous versions remain traceable.

## Current remaining roadmap for Astra

The approved [image productionization checkpoint](image-gen-improvement.md) defines the proposition-first planner, independent angle/layout, portfolio diversity, approved-human library and resumable generation. Prefer approved TRA humans when strategically useful, without fixed human/graphic quotas; fictional adults remain a later product decision. Use tax documents only when they materially help the concept. Historical manual-test exceptions do not change these implementation boundaries.

The separately owned Proof Library of exact customer reviews and verified case studies extends Company proof/customer-insight context. Stable proof-record selection stays separate from angle/layout and asset provenance. The [Create integration plan](tra-create-integration-plan.md) now owns planner/render integration, with detailed human/Proof requirements in [PR #222](https://github.com/celleree/tra-ai-marketing/pull/222). Proof use-approval semantics and runtime integration remain pending under D; record readiness or ACTIVE status alone is not advertising-use approval.

This is the active Stage 1 implementation order. Astra must verify current `staging` and relevant code/tests before treating any item as incomplete.

Treat already-merged foundations as complete unless current code/tests show a regression or a clearly missing contract. Do not reopen completed historical Issues merely because an older document still describes them as future work.

Company-profile grounding and the cached `LayoutBlueprint` foundation are already implemented foundations. Only reopen them for a specific observed regression or a clearly identified missing contract.

1. Wire GPT-6 Astra with medium reasoning as the creative planning/prompting model for the active pipeline.
2. Complete variation planner, including `SO WHAT?` outcome-chain capture, and small-batch selection.
3. Complete placement-aware format generation, including 9:16, 4:5, and 1:1 variants plus safe-zone enforcement.
4. Complete save-to-library provenance/metadata across all source paths.
5. Complete editing/regeneration and version history.
6. Productionize the local-only video-intelligence/selection path where needed.
7. Complete production hardening for the image workflow, including the quality/compliance release gate.

Before delegation, Astra must classify each item as COMPLETE, PARTIAL, NOT STARTED, or BLOCKED based on current code/tests. Detailed orchestration, delegation, and parallel-work rules live in `docs/agent-workflow.md`.

Use GitHub Issues for task-specific acceptance criteria, but verify completion against code/tests and keep every Issue subordinate to the active product direction in this document unless it explicitly records a newer product decision. `docs/roadmap.md` remains long-term/future direction and does not override this section.
