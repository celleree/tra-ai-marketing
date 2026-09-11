# TRA image generation: remaining strategy

Approved strategy checkpoint — 2026-09-10
Verified implementation baseline: staging `d1c84b823356a3cc8f373f9fe03b2b8fb1b0c425`.

Approved target behavior, not a claim of implementation. This checkpoint supersedes the six-ad experiment instructions; code/tests govern runtime behavior. Follow docs/image-workflow.md for the active image boundaries.

## 1. Foundations to preserve

| Area | Implemented and reusable | Specific gap |
|---|---|---|
| Planner and records | Astra medium-reasoning batch planner; copy, strategy, SO WHAT chain, execution enums, selection reason; persistent creative identities, fingerprints and revisions | Subject, environment, mechanism, proposition and source choices are not fully explicit; a batch-wide human-source boolean is insufficient for per-concept library selection |
| References | Stored TRA/layout assets, category metadata, bounded category-balanced candidate pool; content-hash/model/schema-version layout cache with geometry and reusable mechanisms | Selector still assumes exactly one unique reference per output; route associates library references by array position and uses one uploaded blueprint across the batch |
| Diversity | Whole-batch planning; exact headline/SO WHAT duplicate checks and execution comparisons | Category/awareness difference is mandatory even for different propositions; wording changes can evade semantic repetition checks |
| Video | Persisted analysis jobs, scene/interval extraction, transcripts, observations, technical scoring, scene-aware duplicate groups, cached concept selection and source-bound fresh PNG handoff | Analysis is not reusable human approval. Existing selector favors complete graphics; no curated cross-video human catalog or per-ad human-source choice |
| Rendering and review | Distilled one-ad brief; two seeded tax-document assets; conditional document/photographic-human instructions; exact dimensions, safe zones, deterministic logo, saved actual prompts and human review checklist | External layout pixels are still excluded. No live visual validation of the newly merged boundary; 30+ delivery is not established |

Video code permits configured Production, despite older documentation describing a Preview-only gate; actual deployed configuration was not audited here. Image requests currently allow 2–30 concepts, use two concurrent render workers and a 300-second route. Raising the count alone cannot establish reliable 30+ delivery.

## 2. Independent angle and layout

Implementation checkpoint: versioned proposition/visual fields and independent angle/layout IDs are implemented. Initial planning now receives user-priority uploads plus a bounded library shortlist, with existing cached blueprints. Source relationships are derived by code; selected source/blueprint snapshots persist for revisions. Only the chosen blueprint reaches the renderer; external layout pixels remain excluded. Angle descriptions use current analysis/category metadata and are not a new persistent semantic-analysis cache. Semantic portfolio auditing is the next checkpoint; live visual acceptance is still unmeasured.

**User experience.** Concept cards explain the idea and show separate angle/layout sources. Relevant uploaded references materially influence the portfolio without controlling every ad. Original choices remain available.

**Contract.** Extend existing strategy/SO WHAT fields rather than duplicate them. Add explicit `angle`, `proposition`, `objection`, `mainMessage`, `visualArchetype`, `visualMechanism`, `subject`, `environment` and detailed composition instructions. Retain existing hook, emotion, outcome, awareness, treatment, density and CTA fields. A category is a broad label; a proposition is the particular reason to care or act.

Represent `angleSource` and `layoutSource` independently as an original choice or a known reference ID. Derive the relationship in code:

- **matched:** both reference IDs are the same;
- **original:** both choices are original;
- **mixed:** different references, or one reference-derived choice and one original choice.

Keep these pointers separate from the library's existing `angleSource: ai | manual | legacy | fallback`, which records category-assignment provenance.

| Responsibility | Decision |
|---|---|
| Astra | Choose the strategic idea and execution, then the best supporting angle/layout combination. Consider an angle reference's own layout first, but replace it when another option improves fit or portfolio diversity. Explain unused relevant user references briefly |
| Application | Supply a bounded, diverse shortlist with user references included; hydrate known IDs, check roles/availability, derive relationship, resolve each concept's selected layout and preserve original choices. Reuse cached blueprints; replace the selector's one-reference-per-output requirement |
| Sunburst | Receive the distilled execution/copy, only the selected layout image when applicable, and separately selected approved human/document inputs. Never receive angle-only source pixels, the reference shortlist or portfolio reasoning |
| Persistence | Store concept/source choices, actual attached asset IDs/hashes/roles, cache versions, selection rationale and render brief with the creative. Preserve old records without inventing historical source choices |
| Conditional rules | Apply third-party layout-transfer restrictions only with a layout attachment. Transfer structure, hierarchy, spacing and composition—not people, logos, branding, exact copy, prices, claims, statistics, testimonials or proof |

Enrich the existing cache with angle summaries, mechanisms and missing composition detail. Do not rebuild layout analysis or attach competing layout images. Reference claims remain unapproved; human/document assets retain separate roles.

## 3. Strategic diversity

Implementation checkpoint: initial batches now receive a separate Astra semantic audit before any image rendering. Complete grouping coverage is validated in code; repeated groups and exact duplicate copy/propositions trigger at most one planning repair and re-audit, then fail without image generation if unresolved. Distinct audited ideas may share category, awareness or execution labels. Audit/model/coverage and execution-concentration notes persist with saved planning and stay out of Sunburst. Ordinary edits discard stale portfolio assessments; placement/regeneration retains them. Single-parent VARIATION still uses its existing structural check. This is a bounded batch-audit step, not live validation or the later persisted/resumable portfolio system.

**User experience.** The batch presents different reasons to choose TRA. Strong concepts sharing a category remain eligible.

Use a compact hypothesis record: **problem framing → proposition/objection addressed → functional consequence → meaningful outcome**, plus emotion and awareness. Compare execution separately: archetype, mechanism, subject/environment, composition, treatment and CTA approach. A changed CTA shape, actor or headline does not establish a new marketing idea.

- **Astra:** group candidate ideas by underlying meaning, identify close pairs and choose concepts that add a useful hypothesis. Explicitly examine repeated “questions → conversation → next steps” logic and desk/paper defaults. Use tax documents only when they materially help the concept. Preserve same-category ideas with materially different propositions.
- **Application:** retain known-ID, schema, exact-duplicate and provenance checks. Replace the category/awareness inequality rule in the same change that adds the semantic portfolio contract. Report repeated mechanisms/subjects and unresolved duplicate clusters; do not use enum differences or a fingerprint as proof of originality.
- **Sunburst:** execute one selected idea. No portfolio, clustering rules or instructions to invent strategic differences.
- **Persist:** batch ID, hypothesis summaries, cluster membership, meaningful differences, intentional variation relationships, selected concepts and subsequent review outcomes. Keep strategy out of renderer context.
- **Conditional:** an explicitly requested execution test may repeat a hypothesis, but label it as a variation family and exclude it from the count of distinct acquisition ideas. A standard CTA may repeat across different hypotheses.

Semantic similarity requires judgment. Use Astra's structured audit and human adjudication of ambiguous pairs; defer embedding infrastructure, fixed similarity thresholds and another universal QA model.

## 4. Approved TRA human-frame library

Implementation checkpoint: Video Studio now supports exact-frame preview, explicit approval and deactivate/reactivate controls over persistent source-bound records. Generation offers a bounded, source-checked shortlist of curated notes; Astra selects stable human IDs per concept. Selected sources are freshly extracted and validated before rendering, and complete provenance persists. Revisions recheck approval and remove human-source attachments when edited to a graphic. Optional catalog failures leave graphic/direct-source planning available; selected-source failures stop that human's render. No live visual acceptance has been measured.

**User experience.** Extend the video workflow with inspect/approve/annotate/revoke controls. Future batches discover approved human frames without reuploading or reanalyzing unchanged videos.

**Ranking and deduplication.**

1. Filter for current approval, available matching source, allowed use and usable dimensions before ranking.
2. Reuse scene boundaries, exact hashes, difference hashes and existing duplicate groups. Retain alternatives with meaningfully different pose, crop or expression; do not fill the catalog with adjacent near-identical frames.
3. Rank by concept/placement fit first: visible person, useful pose/action, framing, negative space and ability to preserve identity. Existing technical score is a tiebreaker; its edge/sharpness weighting can favor text-heavy graphics and does not establish human quality.
4. Curators check visibility, expression, blur, occlusion, baked-in captions and crops. Cross-video similarity may suggest duplicates, never automatically identify or merge people.

**Approval is human-owned.** Store approver/time, scope/restrictions, source video/hash, library/frame IDs, timestamp, extraction version and approved preview/PNG hash. Optional person labels are operator-assigned, never inferred from appearance or transcripts. Approval of a person/frame does not approve testimonials, occupations, tax status or source claims.

| Responsibility | Decision |
|---|---|
| Astra | Compare human and graphic treatments; select a human-led concept and approved frame IDs when they strengthen its proposition. It cannot approve a frame or substitute an invented person |
| Application | Retrieve approved candidates, deduplicate/rank the shortlist, validate approval and source binding again before rendering, and use existing selected-frame PNG extraction. Initially retain one source video and the existing bounded 1–3 frames per concept; choose different sources across concepts |
| Sunburst | Receive only the chosen approved human PNGs and that concept's identity/execution instructions, alongside its separately selected layout/document assets |
| Persistence | Reusable approval catalog and annotations; per-creative frame selection and exact source/PNG provenance; revision lineage and revocation state |
| Conditional rules | Identity preservation for human concepts; photographic realism for photographic humans, not all artwork. No fixed human/graphic ratio |

Keep analysis JPEGs/thumbnails provider-ineligible. Reuse their catalog metadata, then obtain fresh source-bound PNGs through the existing handoff; do not promote thumbnails into approved provider assets. Retain original videos. Missing, changed or revoked sources stop new use of that selection; they do not trigger silent identity substitution or delete saved creatives. Source revocation should flag affected records for review.

Adapt the existing metadata selector for human retrieval using curated annotations and approved previews; remove its graphics-first preference for this use.

## 5. Plan a portfolio, then render it

Resumable implementation checkpoint: Create supports persisted portfolios of 2–36 creatives, one globally audited plan, stable reserved IDs, fresh source validation, bounded work requests and saved-result reconciliation. Reopening is read-only until Resume; failed or uncertain work requires explicit retry. Planning and image attempts use separate shared operator counters, including the legacy route. Existing single-request generation remains capped at 30. Deterministic and mocked-browser checks establish infrastructure behavior; paid 12/36-ad staging quality, cost and latency validation remains unmeasured.

1. **Ground and inventory:** approved TRA facts/constraints, user priorities, eligible references and humans, recent selected hypotheses and evidence-backed creative patterns.
2. **Sketch alternatives:** produce compact hypotheses before full render briefs. Consider both human and graphic executions for promising ideas. Bound exploration by the planning budget; stop adding weak near-duplicates merely to reach a count.
3. **Select for marginal value:** prioritize relevance, factual support and persuasive strength, then the strategic contribution to the existing portfolio, execution feasibility and visual distinction. Repeat a broad angle only when the new proposition earns its place.
4. **Audit globally:** review all selected summaries together for problem/outcome/objection/emotion/awareness/proposition repetition and execution concentration. Repair weak clusters before paid rendering. Detailed briefs may be produced in chunks, but every chunk sees the same portfolio decisions.
5. **Persist and execute:** save the complete plan and stable concept IDs before rendering. Render bounded chunks with saved progress; reopening/resuming must preserve the portfolio and successful outputs. Uncertain paid calls require explicit retry rather than blind resubmission.

**Adaptive targets, not quotas.** For the selected strategic hypotheses, set a human-opportunity range: lower bound = clear human-treatment wins; upper bound adds equally strong human/graphic alternatives. Four clear fits plus two ties imply 4–6 opportunities for that portfolio, not a permanent ratio. Resolve ties using portfolio diversity; record justified departures.

Likewise, cover strong angle/layout opportunities and penalize repetition without manufacturing category coverage. Useful user references win ties. Reuse a proven layout for a genuinely different proposition; choose original layouts when they improve fit or differentiation.

Distinguish human-accepted patterns from performance-verified results; aesthetic acceptance is not a revenue win. Favor grounded exploration while performance evidence is limited, then adapt reuse to reliable evidence. No permanent 80/20 split.

If the approved facts/assets cannot support the requested number of strong distinct ideas, surface the shortfall and propose a smaller portfolio or additional inputs. Never pad to 30.

## 6. Staging validation and acceptance

**Baseline:** user-reported manual first pass delivered 12/12, with 9/12 creatively acceptable, good visual diversity, weaker strategic diversity, desk/paper repetition and few human-led concepts. It is not an app/API benchmark. Re-score those originals using this rubric if available; otherwise historical human counts and semantic uniqueness remain unknown.

Use a fixed campaign brief, approved-claims snapshot, placement mix and asset catalog. Include useful uploaded references, both document seeds and curated humans. Test in the actual staging app, including reopening saved work and revising an output—not only mocked provider calls. Log model/brief versions, initial outputs, fallback use, failed calls, corrections, cost and timing. Obtain a bounded rendering budget before paid validation.

**Review:** reuse the creative checklist; separately cluster actual copy/imagery by hypothesis without category/source labels. Inspect a contact sheet and mobile-size ads; obtain a second human review for ambiguous pairs. Report strategic and visual distinction separately.

The following are approved acceptance gates, not measured results or production generation quotas:

| Measure | 12-ad validation | Scale validation: 36 ads in one persisted portfolio |
|---|---|---|
| Delivery and persistence | 12/12 initial outputs technically valid and saved/reopenable | 36/36 delivered/saved across bounded chunks; resume without losing or duplicating successful work |
| First-pass quality | At least 10/12 acceptable without correction | At least 30/36 acceptable without correction |
| Strategic distinctness | All 12 planned hypotheses distinct; all accepted outputs distinct | All 36 planned hypotheses distinct; at least 30 acceptable, distinct first-pass ads—not 36 labels for fewer ideas |
| Correction burden | All 12 acceptable and distinct after at most one targeted correction per rejected slot | All 36 acceptable and distinct after the same allowance; otherwise fail the scale gate |
| Hard output rules | Zero material identity/provenance, third-party-transfer, unsupported-claim, logo or placement violations | Same; inspect every output, not a sample |
| Human opportunity | Use the pre-reviewed, asset-informed opportunity range; render selected identities faithfully | Same across the complete portfolio; no drift back to a single person/pose merely because chunks were planned separately |
| Repetition | No unintentional hypothesis duplicates; explain repeated desk/paper mechanisms by concept need | Same globally; later chunks must add useful hypotheses rather than repeat earlier chunks |
| Source routing | Exercise matched, mixed and original, including one-original/one-reference cases; verify correct layout, human and conditional document attachments | Same after resume, source changes and revisions; stale/revoked/unknown selections fail before paid image work |

The 5/6 quality floor improves on 9/12 and scales to 30/36 usable distinct ads. One correction limits endless polishing. These are engineering gates, not statistical proof of marketing performance.

First pass excludes human corrections; log automatic fallbacks separately. Track accepted-distinct ads per dollar, calls per accepted ad, median/p95 time, cache reuse, human share, identity errors, medium drift, unwanted props/text and cluster sizes. Set latency/cost ceilings from the 12-ad run before testing 36; scale must stay within those ceilings and operator limits.

For an asset-rich human-forward test brief, the opportunity range should exceed the historical human share if that count can be recovered. Otherwise report the achieved share and fulfilled human opportunities without claiming a quantified historical improvement. Also exercise no-approved-human and intentionally graphic briefs; neither should force humans.

## Future Proof Library boundary (deferred)

Exact customer reviews and verified case studies will extend, not replace, the existing Company proof/customer-insight context. Keep future evidence selection separate from angle/layout provenance and human/document asset roles. Planner contracts must admit a separately validated stable proof-record ID when the catalog exists; do not encode proof identity as an angle source or copy text. This workstream does not implement proof records, retrieval, approval or selectable placeholder IDs. Future resolution must hydrate the selected verified record before claim use; an ID alone is not proof.

## 7. Small implementation checkpoints

Each row is a bounded deliverable; estimate substantive lines before coding, target ≤200 and split before exceeding 400 or 10 substantive files. All runtime/integration changes need independent exact-HEAD review. Treat approval/authorization or consequential storage changes as HIGH where applicable.

| Order | Deliverable and reuse | Focused acceptance |
|---|---|---|
| 1 | Extend concept fields and backward-compatible planning/render persistence; introduce typed sources alongside validated candidate catalogs | Legacy records remain readable; no invented historical provenance |
| 2 | Enrich cached reference metadata and shortlist selection | Reuse unchanged analyses; uploaded references included; no one-reference-per-output requirement |
| 3 | Wire independent Astra choices and deterministic relationship/ID resolution | Matched/mixed/original cases resolve correctly; no positional source association |
| 4 | Attach selected layout with role-specific restrictions and provenance across generation/revisions | Only chosen layout pixels; angle-only sources excluded; human/document roles preserved |
| 5 | Add portfolio hypotheses/audit and replace the restrictive diversity gate coherently | Paraphrased “next steps” duplicates flagged; genuinely different same-category ideas accepted |
| 6 | Add curated frame approval records and source validation over existing video jobs | Unapproved, stale and revoked selections cannot reach rendering |
| 7 | Extend existing video UI with review, deduplication and reusable human catalog | Approve/search/reopen/revoke; alternatives retained without duplicate analysis |
| 8 | Wire per-concept human retrieval/selection and generation/revision handoff | Different concepts can select different approved sources; no invented identities or fixed ratio |
| 9 | Persist portfolio plan and per-concept progress using existing creative IDs/storage | Save before rendering; reload preserves the complete plan |
| 10 | Add bounded render/resume orchestration and its UI | Respect quotas and uncertain-call retry rules; support 36 without simply raising the current 30/300-second limits |

Rows 6–7 can proceed alongside reference work once source contracts are settled; shared strategy/render/provenance files retain one owner. Rows 9–10 should reuse existing progress delivery and relevant persisted-job patterns, not duplicate the video domain or introduce an unrelated scheduler.

Run the 12-ad gate, fix demonstrated failures in small PRs, then run 36. Advertising performance remains a later evidence-based stage.

### Implementation evidence inspected

Current source anchors: `lib/ai/creative-planner.ts`, `lib/ai/reference-selector.ts`, `lib/references/types.ts`, `lib/layouts/service.ts`, `lib/creatives/strategy.ts`, `diversity.ts`, `render-brief.ts`, `human-review.ts`, `identity.ts`; `app/api/creatives/generate/route.ts`; and `lib/video/{frame-technical-analysis,candidate-technical-selection,concept-selection,visual-observation,selected-frames,selection-cache,preview-availability}.ts`. Corresponding reference/layout/video test files and prior verified renderer/seed integrations informed the reuse boundaries. The strategy audit did not perform live generation; implementation status must be verified against current code/tests.
