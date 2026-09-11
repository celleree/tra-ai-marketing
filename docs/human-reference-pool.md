# Human Reference Pool

Status: NOT STARTED

## Objective
Allow users to select any number of approved TRA video frames. Astra may use that selected pool together with approved TRA Reference images to choose the best human references for each creative. Astra must also plan from approved TRA customer evidence, including review insights and case studies when available.

## Role split
- **Astra:** strategy, copy, concept, evidence grounding, and per-creative human-reference selection.
- **Sunburst:** visual rendering from Astra's brief plus the exact approved TRA human-reference pixels chosen for that creative.

## Hard rules
- No arbitrary user-facing limit on selected video frames.
- TRA Video frames and `TRA_REFERENCE` images are approved human sources.
- `LAYOUT_REFERENCE` and other external-reference humans are never approved human sources.
- Astra may consider the full approved human-reference pool.
- Astra chooses the relevant human reference subset per creative.
- Sunburst receives the exact approved TRA human references selected for that creative; it must not substitute an invented or external person.
- Sunburst does not need every selected frame on every render.
- Preserve exact source/frame provenance for each generated creative.
- Real provider, payload, or context limits are handled internally and must not become the user's selection limit.
- Astra must receive `knowledge/customer-insights.md` when customer language, personas, objections, trust, proof, or review-derived strategy is relevant.
- Raw reviews may be consulted when exact evidence is needed, but customer names, exact quotes, outcomes, or statistics are not ad-safe unless evidence and permission for that use are confirmed.
- Astra may use case studies only from an approved canonical source. Do not invent or infer missing case-study facts.

## Current gaps
- Video Intelligence UI limits selection to 3 frames.
- Generation request/selection contracts limit video frame selections to 3.
- The provider handoff currently down-selects the approved video frame set before image generation.
- Existing workflow documentation still describes 1-3 selected frames.
- Review-derived strategy exists in `knowledge/customer-insights.md`, but this spec must verify it reaches Astra in the active planning path.
- No canonical approved case-study source was found in the current repo or available project files.

## Required changes
- [ ] Remove the 3-frame UI selection cap.
- [ ] Remove the 3-frame request and provenance contract caps while retaining validation for non-empty, valid, unique, source-bound frames.
- [ ] Make the full user-selected frame pool available to Astra planning.
- [ ] Allow Astra to combine approved TRA Video frames with approved `TRA_REFERENCE` human sources.
- [ ] Have Astra choose the relevant human reference subset for each individual creative.
- [ ] Pass that exact per-creative human-reference subset to Sunburst rather than every selected frame.
- [ ] Verify Sunburst is actually grounded by the attached selected TRA human pixels and cannot silently switch to an invented/external person.
- [ ] Preserve exact TRA source and frame provenance for every generated creative.
- [ ] Verify `knowledge/customer-insights.md` is included in Astra's relevant planning context.
- [ ] Keep the raw TRA review source available for exact-evidence retrieval without treating raw quotes/outcomes as automatically approved ad claims.
- [ ] Establish one canonical approved TRA case-study source or approved case-study summary.
- [ ] Make relevant approved case-study facts available to Astra planning with source identity/provenance.
- [ ] Ensure Astra distinguishes strategy inspiration from claims that require evidence/permission before rendering.
- [ ] Update focused tests for selection, validation, Astra grounding, human-reference handoff, and provenance.
- [ ] Update `docs/image-workflow.md` so it no longer states or implies a 1-3 user selection limit and reflects the approved evidence-grounding behavior.

## Definition of done
- A user can select more than 3 approved video frames.
- A valid request containing more than 3 selected frames succeeds.
- All selected frames remain available to Astra as the approved pool.
- Different creatives in one batch can use different video frames and/or TRA Reference humans.
- Each Sunburst request receives the exact approved human references Astra chose for that creative.
- Generated humans remain visibly grounded in approved TRA source pixels rather than invented/external identities.
- No Layout Reference or external person can enter the approved human path.
- Astra demonstrably receives relevant review-derived customer insights during planning.
- Astra can retrieve relevant approved case-study facts once the canonical case-study source exists.
- Review/case-study evidence is never converted into unsupported or unapproved claims.
- Saved provenance identifies the exact source assets, video frames, and evidence sources actually used by each creative where applicable.
- Relevant tests pass.

## Do not do
- Do not rebuild Video Intelligence.
- Do not change frame extraction unless current behavior blocks this objective.
- Do not send every selected frame to every Sunburst request.
- Do not loosen the restriction on third-party/external humans.
- Do not invent case studies, customer quotes, outcomes, or proof.
- Do not expand this work into unrelated image-generation changes.

## Likely implementation targets
Inspect current `staging` before editing; paths may change.

- `components/video-intelligence/selected-frame-generation.tsx`
- `lib/video/generation-selection-contract.ts`
- `lib/creatives/generate-request.ts`
- `lib/ai/video-frame-generation.ts`
- Astra planner/company-context code reached from the active generation path
- generation/provenance code reached from those paths
- `knowledge/customer-insights.md`
- approved case-study source once established
- focused tests under `tests/video/`, `tests/creatives/`, and `tests/ai/`
- `docs/image-workflow.md`

## Scope rule for adding tasks
Add a task here only when it directly affects approved human-source selection, Astra customer-evidence grounding, the Astra-to-Sunburst handoff, validation, or provenance. Put unrelated work in a separate issue/spec so this file stays small and executable.

## Progress
`NOT STARTED -> IN PROGRESS -> VERIFIED -> COMPLETE`
