# Human Reference Pool

Status: NOT STARTED

## Objective
Allow users to select any number of approved TRA video frames. Astra may use that selected pool together with approved TRA Reference images to choose the best human references for each creative.

## Hard rules
- No arbitrary user-facing limit on selected video frames.
- TRA Video frames and `TRA_REFERENCE` images are approved human sources.
- `LAYOUT_REFERENCE` and other external-reference humans are never approved human sources.
- Astra may consider the full approved human-reference pool.
- Astra chooses the relevant human reference subset per creative.
- Sunburst does not need every selected frame on every render.
- Preserve exact source/frame provenance for each generated creative.
- Real provider, payload, or context limits are handled internally and must not become the user's selection limit.

## Current gaps
- Video Intelligence UI limits selection to 3 frames.
- Generation request/selection contracts limit video frame selections to 3.
- The provider handoff currently down-selects the approved video frame set before image generation.
- Existing workflow documentation still describes 1-3 selected frames.

## Required changes
- [ ] Remove the 3-frame UI selection cap.
- [ ] Remove the 3-frame request and provenance contract caps while retaining validation for non-empty, valid, unique, source-bound frames.
- [ ] Make the full user-selected frame pool available to Astra planning.
- [ ] Allow Astra to combine approved TRA Video frames with approved `TRA_REFERENCE` human sources.
- [ ] Have Astra choose the relevant human reference subset for each individual creative.
- [ ] Pass only that per-creative subset to Sunburst rather than every selected frame.
- [ ] Preserve exact TRA source and frame provenance for every generated creative.
- [ ] Update focused tests for selection, validation, planning/handoff, and provenance.
- [ ] Update `docs/image-workflow.md` so it no longer states or implies a 1-3 user selection limit.

## Definition of done
- A user can select more than 3 approved video frames.
- A valid request containing more than 3 selected frames succeeds.
- All selected frames remain available to Astra as the approved pool.
- Different creatives in one batch can use different video frames and/or TRA Reference humans.
- Each Sunburst request receives only the human references Astra chose for that creative.
- No Layout Reference or external person can enter the approved human path.
- Saved provenance identifies the exact source assets and video frames actually used by each creative.
- Relevant tests pass.

## Do not do
- Do not rebuild Video Intelligence.
- Do not change frame extraction unless current behavior blocks this objective.
- Do not send every selected frame to every Sunburst request.
- Do not loosen the restriction on third-party/external humans.
- Do not expand this work into unrelated image-generation changes.

## Likely implementation targets
Inspect current `staging` before editing; paths may change.

- `components/video-intelligence/selected-frame-generation.tsx`
- `lib/video/generation-selection-contract.ts`
- `lib/creatives/generate-request.ts`
- `lib/ai/video-frame-generation.ts`
- generation/provenance code reached from those paths
- focused tests under `tests/video/`, `tests/creatives/`, and `tests/ai/`
- `docs/image-workflow.md`

## Scope rule for adding tasks
Add a task here only when it directly affects the Human Reference Pool objective, its validation, its per-creative Astra/Sunburst handoff, or its provenance. Put unrelated work in a separate issue/spec so this file stays small and executable.

## Progress
`NOT STARTED -> IN PROGRESS -> VERIFIED -> COMPLETE`
