# Create integration completion plan

**Status: PLANNED — runtime implementation and final staging verification remain open.**
**Inspected baseline:** staging `15e217bba0c2cdcada3cb2d9aa73c6e495daf502` (2026-09-11).

## Goal and completion rule

Finish the missing parts and connect the existing systems to normal **Create → Astra → Sunburst → saved creative → revision**. Preserve the working foundations.

The work is complete only when every row in the inventory is built, connected to its intended user flow, and verified on the final combined staging version. A merged PR, a passing isolated subsystem test, or merely including data in a prompt is not enough.

For import/management/revision features, “connected” means their outputs are consumed by Create and retained downstream when relevant. CSV imports, approvals and revisions remain deliberate user actions. Source eligibility does not mean every asset, proof record, human or layout must appear in every ad.

## Confirmed starting point

- PRs #225 and #226 are merged. Normal Create uses `advancePortfolioPreparation`, which still stores one `analysis` chosen with source precedence. The older `prepareCreativeGeneration` also chooses layout/TRA-image/video as alternatives. Both paths require aligned fixes.
- Video Intelligence already has durable preparation/transcription/observation/finalization jobs, a transcript-linked library, and cached selection. A video upload to normal Create does not automatically consume that pipeline.
- A simultaneous TRA image can also suppress the fallback video frames in `hydrateGenerationSources`. Inspect all supplied roles independently.
- Reference category metadata and cached blueprints exist; reusable semantic angle summaries are still synthesized from category/selection rationale. Complete the missing reusable metadata rather than treating this earlier green row as finished.
- Proof Library records, API/UI and review CSV import exist. The current planner arguments do not retrieve/select Proof records.
- Human selection supports one curated human ID or a direct source. Request/provenance/UI and the standalone concept selector enforce three-frame bounds; the provider also down-selects frames.
- Company/customer-insight themes reach Astra through the runtime company profile. This is not evidence that the separate `knowledge/customer-insights.md` file is automatically loaded.
- The render brief includes headline, primary text and description. Prompt-only, TRA-image and video adapters append them again. Every adapter must honor the new image-text contract.
- The user reports 12 outputs from the latest test but poor copy/source use. This establishes reported delivery, not a full quality, cost, or end-to-end pass.

## Ownership and existing plans

This plan is the single umbrella for this integration completion work. Keep implementation acceptance and evidence here; use small linked PRs. Update concise canonical docs only for durable decisions/current status.

- [PR #222](https://github.com/celleree/tra-ai-marketing/pull/222) / `docs/human-reference-pool.md` owns the detailed human-pool and Proof requirements. Reuse and reconcile it; do not build a second competing implementation.
- [Issue #224](https://github.com/celleree/tra-ai-marketing/issues/224) owns planning speed/resumability. A/B are present; targeted repair C and optional auditor evaluation D remain separate. Fix source/copy quality first, then reassess C; D remains optional. Do not duplicate or silently close [Issue #224](https://github.com/celleree/tra-ai-marketing/issues/224).
- Coordinate with any active planning-system cleanup before editing `portfolio-preparation`, `prepare-generation`, planner schemas or persisted jobs. Do not combine unrelated cleanup into these PRs.
- Cleanup ownership remains **unconfirmed**. No identified cleanup PR is not proof that no cleanup exists. Recheck published changes before each checkpoint; stop for a concrete conflict, not merely an unanswered ownership question.
- `docs/image-workflow.md` remains the architecture authority except for the explicitly newer decisions below. The attached historical roadmap's Claude/Sol/Image-2 chain must not override current Astra/Sunburst behavior.
- Recheck live staging and active branches before each PR; this SHA is an audit baseline, not a frozen future base.

## Current decisions to record

This user request activates automatic Video Intelligence and Proof use from normal Create and replaces the old “separate Video Intelligence step required / 1–3 selected frames” direction. It also replaces the rendering assumption that all Meta copy fields are image text.

Preserve Astra Medium as strategist, the semantic audit, current Sunburst routing, exact supplied logo, brand/guardrails, durable identities, and explicit retry for uncertain paid work. Keep external Layout Reference pixels analysis-only; use their validated blueprint. No fictional/external-human fallback, fixed human quota, new model-review chain, autonomous ad publishing or Production promotion is included.

“Full video” means analyze the video's available duration and retain its transcript/scenes; retrieve compact relevant context for planning. It does not mean attach the raw video or every frame to every image request. “Full selected pool” means every eligible chosen asset remains available to selection; internal context/provider limits must not silently delete choices.

## Phases and small PR boundaries

Each listed checkpoint is a proposed smallest coherent PR, not permission to bundle a whole phase. Prefer ≤200 substantive lines; normal ceiling ≤400, split-or-justify >10 substantive files. Keep compatibility and valid intermediate states; a connected contract change may justify a larger coherent slice under existing policy.

| Phase | Outcome | Depends on | Starting route |
|---|---|---|---|
| A | One complete source inventory; video, TRA image and layout coexist | Current baseline / cleanup coordination | Astra Medium for initial A1 assessment; reassess for shared-contract implementation; Sol Medium for bounded wiring |
| B | Normal Create reuses/runs full Video Intelligence and gives it to Astra | A | Astra High for persisted-job integration; Sol Medium for adapters |
| C | Full approved human pool and exact per-ad selections | A, B | Sol High; Astra High for source/provenance review |
| D | Relevant Reviews/Case Studies reach Astra with exact evidence | A, B; review shared contracts with C | Sol High |
| E | Short natural copy; image text separated from Meta fields | A; D before final proof-render acceptance | Sol Medium; Terra Medium for narrow UI mappings |
| F | Layout fidelity and simple generation progress | A, B, E; C for human-layout acceptance | Terra Medium |
| G | Combined regression review and real staging acceptance for every row | A–F | Astra High for integration review; human quality adjudication |

### A — Compose sources without suppressing each other

- [ ] **A1:** Reconcile the current checkpoint, [PR #222](https://github.com/celleree/tra-ai-marketing/pull/222) and actual code. Establish a small versioned planning-source packet with separate video intelligence, TRA-reference analysis, layout catalog/blueprints, human candidates and proof references. Keep source IDs/hashes/version information and distinguish creative inspiration from approved evidence. Reuse existing records rather than duplicate storage.
- [ ] **A2:** Route each supplied source independently through both current entry points. In the persisted path, save each result separately; layout completion must never mean video analysis is complete. Share narrowly scoped composition/validation where it prevents divergence; leave broader extraction to the cleanup owner.

- [ ] **A3:** Complete reusable reference planning metadata using the existing reference/layout cache: stable reference ID, angle summary, layout blueprint, visual mechanism and optional curated notes/tags. Separate cached reusable analysis from per-request selection rationale; invalidate by content hash/model/schema version. Avoid a second reference store and repeated analysis of unchanged assets.

#### A1 contract checkpoint

`PlanningSourcePacketV1` in `lib/creatives/planning-source-packet.ts` defines the shared inventory using existing domain types. A1 merged in PR #228. This is a type/documentation checkpoint, not runtime integration or final staging verification; all final inventory checks remain pending.

| Packet field | Existing authority and boundary |
|---|---|
| `requestedSources` | Existing role/media-ID/SHA-256 provenance. Every supplied role remains accounted for independently. |
| `videoIntelligence` | Existing job locator/analyzer fingerprint, job ID, result artifact hash and library identity/version; bounded timestamped transcript/observation projections, explicitly unverified as evidence and provider-ineligible. |
| `traReferenceAnalyses` | Existing `CreativeReferenceAnalysis` per TRA image ID/hash. Capture model/schema/context hash when produced; unknown historical analyzer metadata stays null. Analysis is inspiration, not approved claims. |
| `referenceCatalog` | Existing `ReferencePlanningCandidate` and versioned blueprint/cache. Retain IDs/hashes/model and independent angle/layout choices; no external pixels. Reusable semantic enrichment remains A3. |
| `humanCandidates` | Existing approved-human records, selected-frame provenance and TRA-image identities. Readiness is not permission; C revalidates approval, source binding and exact fresh pixels. No external-human candidate. |
| `proofReferences` | Existing Proof record ID/type/`updatedAt` revision token. D hydrates exact text, approved wording, attribution permission, restrictions and disclaimer before use. No duplicate evidence store. |

Readiness is `PENDING`, `READY`, `UNAVAILABLE` or `RETRY_REQUIRED`; catalogs also distinguish `NOT_REQUESTED` from `READY` with zero results. Missing requested sources cannot become empty arrays or successful preparation. A supplied layout remains unresolved until its matching ID/hash is accounted for in the catalog. `READY` means data is available, never that evidence, identity or provider use is approved. These are inventory observations; existing jobs remain authoritative for leases, advancement and retry.

Keep packet data JSON-serializable and compact: no buffers, thumbnails, hydrated eligibility objects or complete video libraries. Preserve the portfolio parser's current 2 MiB bound. Company/brand context stays in its existing planner path; the separate customer-insights file is not assumed loaded. Video observations, reference inspiration and human approval do not establish factual evidence.

Do not invent missing analyses, analyzer versions or historical source choices; keep existing completed/uncertain-work retry behavior. D must resolve Proof advertising-use approval semantics; `ACTIVE`, CSV import or record presence alone does not confer permission. C owns full-pool eligibility/selection. A1 changes no request, planner response, parser, persisted job or provider behavior.

#### A2 compatibility and bounded checkpoints

Accepted compatibility: grandfather existing portfolios under their saved composition behavior, including partially prepared jobs. Preserve completed analyses, plans/audits, quota reservations, leases, frame identities and saved slots. No automatic upgrade or inferred source provenance; composed-source behavior will require a deliberate new portfolio after activation. Explicit Retry retains the existing mode and uncertain-paid-work semantics.

A2.1 adds immutable `sourceCompositionVersion` to the portfolio record. `1` names today's legacy composition; an absent marker means legacy and stays absent through reads/updates. New portfolios explicitly record `1`; other values fail with an unsupported-version error. This marker is independent of the job/snapshot/packet schema versions. New composition remains disabled; no preparation, provider or retry implementation changes.

Accepted request boundary: A2.5 may allow explicitly selected video frames alongside layouts, retaining current frame bounds and validation. Selected frames plus TRA images stay gated until C resolves human-source selection. Ordinary uploaded video + TRA image + layout composition remains in A2 scope. Render attachments and identity permissions must not expand merely because another source was analyzed.

| Checkpoint | Coherent boundary | Estimate including focused tests |
|---|---|---:|
| A2.1 | Immutable version/read/update compatibility and these decisions; new composition disabled. | 100–200 lines |
| A2.2 | Shared incremental source analysis and a distinct representative-frame analysis projection; account for all supplied roles. Existing callers remain unchanged. | 220–320 lines |
| A2.3 | Planner and snapshot/parser support for the compact A2 projection; new producers remain disabled. | 160–240 lines |
| A2.4 | Activate composition for new portfolios and the legacy request entry together; preserve per-operation checkpoints and grandfathered jobs. | 260–380 lines |
| A2.5 | Permit selected frames + layouts at the request boundary, with focused validation/integration tests. | 60–110 lines |

Each checkpoint needs focused checks and fresh independent review of its final HEAD when required. Reassess size and published overlap after each merge; keep valid intermediate behavior. A2.2–A2.5 have not begun. B owns automatic Video Intelligence, C/D own human/Proof selection, A3 owns metadata enrichment and #224 owns planning optimization. Full source integration and all final staging verification remain pending.

**Verify:** actual portfolio entry plus legacy entry with video-only, layout-only, TRA-image-only, video+layout, and video+TRA-image+layout fixtures. Assert both video and layout facts reach the real Astra request and survive checkpoint/reload. Missing required sources produce a visible, specific state.

**Start files:** `lib/creatives/{generation-sources,portfolio-preparation,prepare-generation}.ts`, portfolio preparation state/parser/snapshot, directly relevant route tests.

### B — Use the Video Intelligence already built

- [ ] **B1:** Attach/reuse the existing video job/library by source hash and analysis version from the portfolio preparation state. A user-started Generate can drive bounded existing job steps; GET/reopen is read-only. Do not call the entire pipeline inside one long portfolio request. Preserve leases, authentication, operator budgets, stable IDs, result recovery, and explicit retry after an uncertain paid step.
- [ ] **B2:** Provide timestamped transcript excerpts, visual observations, scene coverage, known frame IDs and relevant selection context to Astra. Cache reuse must work across reload/resume and repeated use of unchanged media. Include later-video information, not only the opening frame or thumbnail. No extra generic video-analysis model call is needed when the intelligence already contains that information.
- [ ] **B3:** Bring cached intelligent selection into Create and provide source progress/error handling. Handle silent/no-speech video explicitly; use visual information without fabricating a transcript. Failed/unavailable required analysis must not silently fall back to thumbnail-only planning. Make a deliberate reduced-source choice visible if supported.

**Verify:** a fixture with a distinctive useful message only late in the video; a fresh source, cached source, changed hash, silent video, interrupted preparation, and uncertain provider outcome. Record transcript/library IDs and actual planner input. Reopening a completed analysis makes zero new analysis calls.

**Reuse:** `lib/video/intelligence-service.ts`, existing job runners/client, `frame-library`, `selection-context`, `selection-cache`, `concept-selection`; update only proven blockers in extraction.

### C — Full human pool, selected separately for each creative

- [ ] **C1:** Add a versioned unified eligible source catalog covering selected video frames, existing approved-human records and approved `TRA_REFERENCE` images. Preserve access to all user-selected candidates using metadata/paging if needed. Avoid an arbitrary catalog slice hiding relevant selected sources.
- [ ] **C2:** Remove the three-frame selection restriction across UI, request validation, saved provenance, selector response/cache and any downstream extraction assumptions. Display the usable library, not merely a three-result shortlist. Validate nonempty/unique IDs, source ownership, hashes, approval, timestamp and decodable fresh PNGs. Keep real technical/provider budgets internal.
- [ ] **C3:** Astra selects validated human source IDs/subsets per creative. The renderer receives exactly that subset; remove silent first/middle/last re-selection. Support multiple eligible source types in a portfolio without blending different identities or treating Layout Reference people as eligible. Revalidate at render and revision time, including revoked/missing/stale sources; retain exact actual attachment provenance.

**Verify:** >3 selected frames through the UI and request, a useful candidate beyond the old first three, different source choices across creatives, both video and TRA-image candidates, and no-human/graphic briefs. Check attached IDs/hashes against planned IDs/hashes. Inspect actual humans visually; correct attachment alone cannot prove identity fidelity.

### D — Ground evidence using the existing Proof Library

- [ ] **D1:** Add relevant, bounded retrieval over eligible ACTIVE Reviews and Case Studies using the existing store and metadata. Pass exact review text, approved claim wording, restrictions, disclaimer, attribution permission and stable record identity to Astra. Check the existing authorization meaning of ACTIVE; CSV import or active status alone must not manufacture permission for advertising use. If required evidence/use approval is not recorded, add the smallest explicit approval field/workflow to the existing Proof schema/UI and leave unconfirmed records ineligible. Missing relevant proof stays unavailable; no new evidence database or mandatory embedding/model layer.
- [ ] **D2:** Add per-creative evidence selection and validation. Hydrate known records, reject unknown/inactive/stale/unsupported selections, and preserve exact quotes or explicitly source-bound excerpts without changing their meaning. Attribution needs the record's permission. Verified facts do not authorize universal promises.
- [ ] **D3:** Persist used proof ID/version or content hash, selected text/claim and restrictions separately from human/layout provenance. Revalidate before paid rendering and revisions; retain historical snapshots without claiming revoked proof is currently eligible. Wire imported reviews and current case-study UI records into this same retrieval path.
- [ ] **D4:** Connect useful video case-study passages to existing approved Proof records. Surface unmatched passages as timestamped candidates for TRA's review through the existing evidence workflow; do not automatically approve model-extracted facts. Verify distilled customer-insight content reaches Astra once, separately from exact proof.

**Verify:** an imported multiline exact review, allowed vs disallowed attribution, a case study with restrictions/disclaimer, no relevant proof, inactive/edited evidence, and a source passage with an unsupported outcome. Confirm exact used proof in actual planner output, render brief, saved creative, reload and revision. If a chosen review cannot fit the image naturally, choose an approved shorter excerpt or keep it in Meta copy; never rewrite a quotation to fit.

### E — Fix copy and image text together

- [ ] **E1:** Introduce backward-compatible `adCopy` (Meta primary text/headline/description) and explicit `imageCopy` (image headline, optional short support, optional proof/attribution, optional CTA, applicable disclosure) in plan/persistence/revision contracts. Image text is intentional; no automatic promotion of Meta primary text or description onto the image. Keep legacy records readable without inventing historical choices.
- [ ] **E2:** Use plain consumer language: one clear idea, short natural sentences, no redundant explanation. Primary text adds context; headline is a hook. Reject normalized identical headline/primary text and use existing planning/audit/human review for meaning-level repetition. No extra universal model call just for copy. As normal design guidance, aim for a 3–8-word image headline and at most one short support line; proof-led layouts and required disclosures are explicit exceptions. Validate mobile legibility, not word count alone.
- [ ] **E3:** Update render brief plus prompt-only, TRA-image, video-frame and revision adapters so only `imageCopy` can become image text. Remove appended Meta fields. Preserve selected proof, required disclaimers, source rules and exact logo handling. Map Meta fields correctly in cards/details/export without displaying headline twice.

**Verify:** capture every adapter's actual outbound prompt and attachments; sentinel Meta-only text is absent from the image brief; required disclosures/selected proof are present. Check create → save → reload → edit/regenerate/variation → 4:5/9:16. Inspect real outputs for awkward copy, repetition and text overload.

### F — Respect chosen layouts and show useful progress

- [ ] **F1:** Preserve the selected blueprint's meaningful hierarchy, region count, image position, whitespace and restrained text density. For the reported example, explicitly test headline + approved man on the left + approved review below, with relevant proof. Keep angle/layout independent and user-priority references optional overall; test chosen-layout fidelity separately from the percentage of ads choosing it. Do not add raw external layout pixels or extra badges/cards/sections.
- [ ] **F2:** Replace the machinery-heavy progress panel with **“Planning 12 creatives…”**, **“0 / 12”**, a visual progress bar, and **“Stop generation”** (count reflects actual requested N). Show useful video/planning/generating/stopped states. Completed count comes from saved slots; no fabricated planning percentage. Stop prevents new work after the in-flight operation settles, preserves results, and makes that state clear. Reopen loads automatically but starts no paid work; Resume and uncertain-work Retry remain explicit.

**Verify:** desktop/mobile/keyboard, accessible live progress and bar values, zero/partial/completed counts, Stop during video/planning/render, reopen/resume and failure/retry. Keep optional technical details out of the normal flow.

### G — Prove the complete flow and close the table

- [ ] **G1:** Run focused integration tests at each boundary and existing CI for full tests/typecheck/build; obtain independent review of the final current PR HEAD where required. After integration, review the combined staging change, not just individual PRs. Any changed HEAD invalidates a required earlier exact-HEAD review.
- [ ] **G2:** Validate actual staging R2 upload, image display, source hydration, download, signed-link refresh and allowed-origin/CORS behavior. Keep deployed configuration and app release identity in the evidence.
- [ ] **G3:** Run a real 12-ad portfolio from normal Create with a video containing useful later content, simple layout reference, available approved TRA human images, and relevant approved Review/Case Study records. First use controlled fixtures/mocks to eliminate avoidable failures. Record source coverage and actual requests/records, then inspect every delivered ad.
- [ ] **G4:** Exercise refresh/Stop/resume, one edited creative and 1:1/4:5/9:16 variants, missing/revoked sources, no-human and graphic briefs. Run 36 only after the 12-ad quality/cost gate passes and the existing bounded paid-validation authorization covers it; otherwise record the exact remaining budget/asset/access need.
- [ ] **G5:** Revisit every inventory row below. Attach evidence and only then set final staging verification to ✅. Reopen any row invalidated by a later change. Close this workstream only with no partial/failed/unverified in-scope rows.

**Quality gates from the active checkpoint:** 12/12 technically valid and saved; ≥10/12 acceptable first-pass; all 12 planned hypotheses strategically distinct; all 12 acceptable/distinct after at most one targeted correction per rejected slot. Scale: 36/36 saved, ≥30/36 acceptable and distinct first-pass, all 36 acceptable/distinct within the same correction allowance. Preserve zero unauthorized identity/claims/logo violations. Do not lower these thresholds to make the table green.

**Record:** deployed SHA/URL, portfolio ID, input media/library/proof IDs and versions, selected-vs-attached source IDs, actual prompts/brief versions, cold vs cached video analysis calls/time/cost, plan/audit/repair/render calls, tokens/cache hits where available, total timing, and `12 generated / technically successful / acceptable first-pass / strategically unique`. Do not manufacture unavailable metrics.

**Cost guard:** reuse cached video/layout/selection/Proof context, avoid full transcripts/images in every render, do not re-run completed provider work, and preserve the existing successful plan+audit path. First-time transcription/observations are real work and may add cost compared with the previously bypassed flow; report that separately. Do not promise zero added total cost or silently downgrade quality. Keep [Issue #224](https://github.com/celleree/tra-ai-marketing/issues/224)'s planning-cost guard and compare cost per accepted distinct ad.

**Final per-row evidence format:** `row ID | final staging SHA | focused/integration check | portfolio/creative ID or browser evidence | result | remaining blocker`. No placeholders or inherited green checks count as final verification.

## Complete feature inventory

Built/connected columns are the initial implementation inventory, using the earlier table plus targeted current-source inspection; they are not fresh release certification. ✅ = present, ⚠️ = partial, ❌ = missing or unavailable through normal Create. “Final verified” starts ⏳ for every row. Connected for optional flows means consumed when relevant/supplied. The original 41 rows are retained; eight reported requirements are added.

| ID | Part | Built? | Connected? | Work or retest | Phase | Final verified |
|---|---|---:|---:|---|---|---:|
| 01 | Astra creative strategist/planner | ✅ | ✅ | Preserve Astra Medium; inspect actual Create planner input and accepted plan. | A, G | ⏳ |
| 02 | Astra portfolio diversity planning | ✅ | ✅ | Keep global hypotheses and source choices through all new integrations. | A, G | ⏳ |
| 03 | Layout Blueprint extraction | ✅ | ✅ | Reuse cached blueprint; retain selected geometry on actual output. | A, F, G | ⏳ |
| 04 | Layout Reference → Astra | ✅ | ✅ | Reach planner alongside video/TRA analysis; verify chosen layout and original choices. | A, F, G | ⏳ |
| 05 | Reference Library | ✅ | ✅ | Retest catalog discovery, selected IDs, and user-reference priority. | A, G | ⏳ |
| 06 | Reference planning metadata | ⚠️ | ⚠️ | Reuse existing category/blueprint cache; finish reusable angle/mechanism metadata and cache invalidation. | A, G | ⏳ |
| 07 | TRA Reference ad analysis | ✅ | ⚠️ | Run when supplied even alongside a Layout Reference or video. | A, G | ⏳ |
| 08 | Video Intelligence | ✅ | ❌ | Automatically reuse/start its existing durable job from normal Create. | B, G | ⏳ |
| 09 | Video transcription | ✅ | ❌ | Process full video audio; persist timestamped transcript; deliver relevant content to Astra. | B, G | ⏳ |
| 10 | Scene/frame extraction | ✅ | ⚠️ | Use full-duration intelligence candidates rather than just the fallback representative set. | B, G | ⏳ |
| 11 | Visual video observations | ✅ | ⚠️ | Deliver source-bound observations with transcript context, including later scenes. | B, G | ⏳ |
| 12 | Transcript-linked video frame library | ✅ | ❌ | Load the completed library into Create; preserve source identity and temporal links. | B, G | ⏳ |
| 13 | Intelligent video-frame selection | ✅ | ❌ | Use existing selection intelligence from Create; remove graphics-first bias for human selection. | B, C, G | ⏳ |
| 14 | Selected video frames → generation | ✅ | ⚠️ | Use the exact per-ad chosen frames and record actual attachments. | C, G | ⏳ |
| 15 | Approved video-human frames | ✅ | ✅ | Preserve fresh verified PNG extraction and source/approval checks. | C, G | ⏳ |
| 16 | Approved Human Library | ✅ | ✅ | Reuse existing records, approval/revocation, and metadata; widen discovery as required. | C, G | ⏳ |
| 17 | Full human-source pool for Astra | ⚠️ | ❌ | Make every eligible selected source discoverable; internally page/index large pools. | C, G | ⏳ |
| 18 | Unlimited user-selected video frames | ❌ | ❌ | Remove arbitrary 1–3 UI/request/provenance caps; keep real validation and internal budgets. | C, G | ⏳ |
| 19 | Astra chooses human per creative | ⚠️ | ⚠️ | Choose a validated subset per ad across the unified pool; do not add a human quota. | C, G | ⏳ |
| 20 | TRA_REFERENCE humans as approved human sources | ⚠️ | ⚠️ | Include eligible TRA image sources alongside video sources; preserve identity permissions. | C, G | ⏳ |
| 21 | Exact human provenance | ✅ | ✅ | Extend existing provenance to all new per-ad subsets and revisions; check actual pixels too. | C, G | ⏳ |
| 22 | Proof Library | ✅ | ❌ | Retrieve eligible records during normal planning using the existing store. | D, G | ⏳ |
| 23 | Reviews storage/API/UI | ✅ | ❌ | Keep existing management; records become available to normal Create evidence retrieval. | D, G | ⏳ |
| 24 | Review CSV import | ✅ | ❌ | Imported exact reviews become retrievable; import stays an explicit user action. | D, G | ⏳ |
| 25 | Case-study/proof records | ✅ | ❌ | Use existing verifiedFacts/approvedClaimWording/restrictions/disclaimer records. | D, G | ⏳ |
| 26 | Proof retrieval for Astra | ❌ | ❌ | Add bounded relevant retrieval and validated stable proof IDs. | D, G | ⏳ |
| 27 | Exact proof provenance in generated ads | ❌ | ❌ | Save used record/version/hash plus exact approved wording/quote, attribution and restrictions. | D, G | ⏳ |
| 28 | Company/brand context | ✅ | ✅ | Retest runtime company profile, customer-insight themes and brand rules in planner input. | A, D, G | ⏳ |
| 29 | TRA guardrails | ✅ | ✅ | Preserve hard source rules; prevent unapproved quotes/outcomes and retain applicable disclaimers. | D, E, G | ⏳ |
| 30 | Distilled Sunburst render brief | ✅ | ✅ | Version it to contain only explicit on-image copy and that ad's selected execution inputs. | E, G | ⏳ |
| 31 | Sunburst image rendering | ✅ | ✅ | Retest prompt-only, TRA-image, video-human and revision adapters with the new contracts. | C, E, G | ⏳ |
| 32 | Layout-reference pixels blocked from final generation | ✅ | ✅ | Preserve current analysis-only policy; transfer approved blueprint geometry. | F, G | ⏳ |
| 33 | Portfolio semantic audit | ✅ | ✅ | Retain global audit; same-category distinct concepts remain eligible. | G | ⏳ |
| 34 | Bounded portfolio repair | ✅ | ✅ | Preserve current bound; [Issue #224](https://github.com/celleree/tra-ai-marketing/issues/224) PR C still owns targeted replacement optimization. | G | ⏳ |
| 35 | Resumable generation jobs | ✅ | ✅ | Persist added preparation dependencies without replaying completed/uncertain paid work. | B, G | ⏳ |
| 36 | 2–36 ad portfolios | ✅ | ✅ | Retest 12, then 36 only after the quality and cost gates pass. | G | ⏳ |
| 37 | Persisted progress/results | ✅ | ✅ | Verify save/reload/returned images and provenance on the final deployment. | B, F, G | ⏳ |
| 38 | Pause/reopen/resume infrastructure | ✅ | ✅ | Retest stop admission, read-only reopen, resume, explicit retry and stable IDs. | B, F, G | ⏳ |
| 39 | Creative revisions | ✅ | ✅ | Carry new text/evidence/human contracts through edits, regeneration, variation and formats. | C, D, E, G | ⏳ |
| 40 | R2 media storage | ✅ | ✅ | Retest upload/storage/read through the real staging bucket and durable source records. | G | ⏳ |
| 41 | Direct browser R2 media delivery | ✅ | ✅ | Verify browser upload/display/download, signed-link refresh and live origin/CORS behavior. | G | ⏳ |
| 42 | Video + Layout Reference used together | ❌ | ❌ | Both current generation paths must retain independent video and layout analyses. | A, B, G | ⏳ |
| 43 | Plain, natural consumer copy | ⚠️ | ⚠️ | Enforce clear short copy without corporate filler; judge the rendered ads at phone size. | E, G | ⏳ |
| 44 | Headline and Meta primary text have different roles | ❌ | ❌ | Reject duplicate normalized fields; assess repetitive meaning during existing review. | E, G | ⏳ |
| 45 | Separate on-image text from Meta ad fields | ❌ | ❌ | Explicit imageCopy vs adCopy; stop all adapter-level primary-text/description leakage. | E, G | ⏳ |
| 46 | Simple layouts and restrained text density | ⚠️ | ⚠️ | Respect selected region count/hierarchy; use only planned optional support/proof/CTA. | E, F, G | ⏳ |
| 47 | User-facing progress bar and Stop generation | ⚠️ | ❌ | Show Planning N creatives… / saved count N / progress bar / Stop generation. | F, G | ⏳ |
| 48 | Exact TRA logo and placement safe zones | ✅ | ✅ | Preserve deterministic supplied-logo placement and test 1:1, 4:5 and 9:16. | G | ⏳ |
| 49 | Video case-study insights → approved evidence use | ⚠️ | ❌ | Surface timestamped candidate facts; link to approved Proof records before claim use. | B, D, G | ⏳ |

## Source anchors for this baseline

- [Active Create preparation](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/creatives/portfolio-preparation.ts), [legacy preparation](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/creatives/prepare-generation.ts), [source hydration](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/creatives/generation-sources.ts).
- [Reference records](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/references/types.ts), [reference planning catalog](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/references/planning.server.ts).
- [Existing Video Intelligence service](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/video/intelligence-service.ts), [concept selection](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/video/concept-selection.ts), [frame selection contracts](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/video/generation-selection-contract.ts).
- [Human candidate loading](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/video/approved-human-planning.ts), [video image adapter](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/ai/video-frame-generation.ts), [render routing](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/creatives/render-planned.ts).
- [Proof record types](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/proof/types.ts), [existing Proof storage](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/proof/storage.ts), [company context](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/company/creative-context.ts).
- [Planner](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/ai/creative-planner.ts), [render brief](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/creatives/render-brief.ts), [TRA image adapter](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/ai/openai.ts), [prompt-only adapter](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/ai/prompt-only-generation.ts), [revision adapter](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/lib/ai/creative-revision-image.ts).
- [Progress panel](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/components/creative-generator/portfolio-progress-panel.tsx), [active image workflow](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/docs/image-workflow.md), [quality gates](https://github.com/celleree/tra-ai-marketing/blob/15e217bba0c2cdcada3cb2d9aa73c6e495daf502/docs/image-gen-improvement.md).

## First bounded Codex task

Routing for A1:

```text
WHERE: Codex Sidebar in VS Code
SESSION: NEW — TRA Create Integration A1
MODEL: GPT-6 Astra
REASONING: Medium
PARALLEL: NO — shared preparation, source and persistence contracts must be settled first
```

**TASK:** A1 only: settle the shared source packet and reconcile current product/checkpoint direction with this integration plan.

**CONTEXT:** Normal Create follows the persisted portfolio path; video+layout currently suppresses video analysis. #225/#226 are merged. Video Intelligence and Proof storage already exist.

**SOURCE OF TRUTH:** `AGENTS.md`, this plan A1 and its invariant decisions, current `docs/image-workflow.md`, [PR #222](https://github.com/celleree/tra-ai-marketing/pull/222), and the directly relevant source/preparation types.

**SCOPE:** Inspect current staging and overlapping cleanup work; specify the smallest compatible source composition contract and the first coherent implementation slice. Update only concise durable docs/types needed for A1. Do not add provider calls, rebuild subsystems, or begin the later phases.

**INSTRUCTIONS:** Follow existing PR-size and review rules. Use a dedicated feature branch from current staging. Use existing session authorization for reversible work; escalate only genuine unresolved product decisions. Keep main unchanged.

**RETURN:** PR/checkpoint, exact relevant files, agreed source packet, compatibility/verification evidence, overlap/dependencies, remaining gaps, and the next bounded A2 task. Later PRs should use the cheapest suitable model from the phase table; reassess rather than inheriting the A1 route.

