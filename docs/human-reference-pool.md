# Human Reference Pool

Status: NOT STARTED

## Objective
Allow users to select any number of approved TRA video frames. Astra may use that selected pool together with approved TRA Reference images to choose the best human references for each creative. Astra must also plan from approved TRA customer evidence in the Proof Library, including Reviews and Case Studies.

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
- **Proof Library is the canonical evidence source for exact customer Reviews and approved Case Studies.**
- `knowledge/customer-insights.md` is the distilled strategy layer for recurring customer language, personas, objections, trust, and proof themes; it does not replace the underlying Proof Library evidence.
- Astra may use relevant Proof Library Reviews and Case Studies when planning creatives.
- Exact review quotes must remain grounded in the stored original review text. Display attribution or customer identity may be used only when the Proof Library record confirms permission for that use.
- Case-study facts may be used only when supported by an approved Proof Library Case Study. Do not invent or infer missing facts.
- Review or case-study evidence must not be converted into unsupported guarantees, universal outcomes, or unapproved claims.

## Current gaps
- Video Intelligence UI limits selection to 3 frames.
- Generation request/selection contracts limit video frame selections to 3.
- The provider handoff currently down-selects the approved video frame set before image generation.
- Existing workflow documentation still describes 1-3 selected frames.
- Review-derived strategy exists in `knowledge/customer-insights.md`, but this spec must verify it reaches Astra in the active planning path.
- The Proof Library already stores Reviews and Case Studies; this spec must verify relevant evidence can reach Astra during active planning.

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
- [ ] Make relevant Proof Library Reviews available to Astra for exact evidence retrieval when needed.
- [ ] Make relevant approved Proof Library Case Studies available to Astra for factual proof and case-study grounding.
- [ ] Preserve Proof Library record identity/provenance when evidence influences a creative.
- [ ] Ensure Astra distinguishes strategy inspiration from claims, quotes, attribution, or outcomes that require exact supporting evidence and permission.
- [ ] Update focused tests for selection, validation, Astra grounding, Proof Library retrieval, human-reference handoff, and provenance.
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
- Astra can retrieve relevant exact Reviews and approved Case Studies from the Proof Library when needed.
- Exact quoted review text and attribution remain constrained by the underlying Proof Library record.
- Review/case-study evidence is never converted into unsupported or unapproved claims.
- Saved provenance identifies the exact source assets, video frames, and Proof Library evidence records actually used by each creative where applicable.
- Relevant tests pass.

## Do not do
- Do not rebuild Video Intelligence.
- Do not change frame extraction unless current behavior blocks this objective.
- Do not send every selected frame to every Sunburst request.
- Do not loosen the restriction on third-party/external humans.
- Do not invent case studies, customer quotes, outcomes, or proof.
- Do not create a duplicate review/case-study evidence store outside the existing Proof Library.
- Do not expand this work into unrelated image-generation changes.

## Likely implementation targets
Inspect current `staging` before editing; paths may change.

- `components/video-intelligence/selected-frame-generation.tsx`
- `lib/video/generation-selection-contract.ts`
- `lib/creatives/generate-request.ts`
- `lib/ai/video-frame-generation.ts`
- Astra planner/company-context code reached from the active generation path
- Proof Library storage/API/retrieval code reached from the active app
- generation/provenance code reached from those paths
- `knowledge/customer-insights.md`
- focused tests under `tests/video/`, `tests/creatives/`, and `tests/ai/`
- `docs/image-workflow.md`

## Scope rule for adding tasks
Add a task here only when it directly affects approved human-source selection, Astra customer-evidence grounding, Proof Library evidence retrieval, the Astra-to-Sunburst handoff, validation, or provenance. Put unrelated work in a separate issue/spec so this file stays small and executable.

## Progress
`NOT STARTED -> IN PROGRESS -> VERIFIED -> COMPLETE`
