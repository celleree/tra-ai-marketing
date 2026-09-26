# Cost and creative regression corpus

This manifest reuses committed assets and deterministic synthetic fixtures. No new paid images, unapproved human crops, or sensitive generated outputs are included. Synthetic checks establish technical behavior; they do not establish visual quality, readable document text, a suitable person, or creative acceptance.

## Available fixtures and permitted use

| Case | Source / executable fixture | Provenance and permitted use | Expected result / limit |
|---|---|---|---|
| Exact logo geometry, every placement and anchor | `tests/creatives/brand-logo-server.test.ts`, `safe-zones.test.ts` | Generated solid-color and transparent PNGs; no real brand or person | Preserve supplied artwork pixels/aspect ratio, exact geometry and safe zones. Does not certify a real logo's identity. |
| Revision removes the prior official panel | `tests/creatives/revision-api.test.ts` | Synthetic image bytes and saved-record fixtures | Correct legacy/default and composition-aware anchor behavior; no new image purchase after saved result recovery. |
| Sharp / blurred image technical control | `tests/video/frame-technical-analysis.test.ts` | Generated checkerboard and blurred derivative | Technical sharpness discrimination only; no document-legibility or human-suitability verdict. |
| Human-frame suitability and NO_SUITABLE_HUMAN lifecycle | `tests/video/human-frame-selection.test.ts`, `tests/creatives/portfolio-video-selection-admission-lifecycle.test.ts` | Solid-color JPEGs and mocked assessments, synthetic source IDs | Correct ranking/gates/caches; cold no-suitable one selection, warm no-suitable zero calls and zero renders. Does not visually judge a real person. |
| Structural tax notice source | `assets/tax-documents/irs-notice-v1.jpg` | User-supplied 2026-09-10, document-structure-only; authority `lib/references/tax-documents.ts` | SHA-256 `2e529956bfb160e3168b48108ab1e2562b501d1e0b97241b635a58d8e1ea95c2`; not sanitized output ground truth. Never copy seals, names/address, identifiers, balance or claims into expected output. |
| Structural tax-mail source | `assets/tax-documents/irs-mail-v1.jpg` | User-supplied 2026-09-10, document-structure-only; same authority | SHA-256 `4aed697b38d0c67679930b0b56e9747189038257d7d6dc6fe8d003a16699299e`; not sanitized output ground truth. Never copy seals, addresses, barcodes, amounts or postage marks into expected output. |
| Source integrity and tax-document request boundary | `tests/references/tax-documents.test.ts` | Existing committed structural assets; verifies canonical hashes and restrictions | Structure can guide generation; source content never becomes verified proof or approved government affiliation. |
| Layout/composition and readable-copy review | `tests/creatives/human-review.test.ts`, `generated-image-validation.test.ts` | Synthetic checklist/PNG fixtures | Checklist persistence and PNG/dimension checks only; real visual judgment remains human. |

## Unavailable visual negatives

No provenance-safe real paid output/crop was available for duplicate source logos, malformed/blurred document text, unsuitable real human frames or failed real compositions. Do not invent passing visual verdicts from mocks or use `public/tra-logo-sidebar.png` as proof of the runtime official-logo source. The runtime official artwork comes from the approved company/source contract.

When an approved output becomes available, add only a sanitized crop with its stable source creative/build identity, SHA-256, dimensions, approved test use, restricted-content handling, and explicit human-reviewed expected verdict. Do not copy full private run output or source personal details into Git to fill this gap. #276 source-contamination behavior is a separate integration prerequisite, not implemented by this corpus.

## Executable cost invariants

| Scenario | Tests / expected provider count |
|---|---|
| Default tests/CI/dev image admission | `image-provider-admission.test.ts`: zero real images with ambient credentials; production markers do not authorize tests. Native Responses and transcription are also blocked in the Vitest setup, including pass-through spies. |
| Authorized diagnostic | `image-render-request.test.ts`, `image-attempt-execution.test.ts`: same Sunburst model, LOW, n=1, no partials, max one primary per scoped run, no fallback. |
| Source-free 36-slot happy path | `portfolio-execution.test.ts`: one plan, one audit, 36 HIGH Sunburst image dispatches, explicit n=1/PNG/no partials; completed advance adds zero. Planner/auditor are mocked; the image request/admission/attempt boundary is real with mocked fetch. |
| Failed diversity repair | Same suite: initial plan plus at most one targeted repair, two audits, zero renders; ordinary repeated advance adds zero. An explicit user-requested planning restart is a separate paid cycle and is not an automatic repair. |
| Revision matrix | `revision-api.test.ts`: EDIT/VARIATION plan1 + image1; PLACEMENT/REGENERATE plan0 + image1; same-intent replay adds zero; a deliberate new intent can purchase one fresh render. |
| Concurrency, saved raw bytes, lost finalization acknowledgement, unknown outcomes | `image-attempt-store.test.ts`, `image-attempt-execution.test.ts`, `generate-route.test.ts`, `revision-api.test.ts`: one concurrent primary; raw/saved creative recovery zero extra image calls; unknown outcome no automatic repeat. |
| Browser refresh, transport retry and deliberate fresh action | `submission-identity.test.ts`, `portfolio-client.test.ts`, `generate-route.test.ts`: session-storage digest/UUID recovery, no sensitive request persistence, stale completion isolation, and explicit reset semantics. Browser integration remains a manual staging check. |
| Terminal versus retryable failures | `image-provider-failure.test.ts`: terminal billing/credit/spend/auth/invalid requests and ambiguous processing failures cannot buy fallback; production allows at most one separately reserved confirmed-transient fallback; smoke/diagnostic allow zero. |
| Warm video and analysis | `selection-cache.test.ts`, `library-service.test.ts`, layout/reference cache tests and portfolio selection lifecycle suites: exact-identity warm reuse adds zero corresponding provider calls. |
| Usage/privacy/estimates | `tests/ai/provider-{usage,telemetry}.test.ts`, `planning-usage.test.ts`, `transcription-usage.test.ts`: allowlisted metadata, distinct primary/fallback attempts, replay no duplicate cost, missing categories unknown, no billed-cost claim. |

Run the named suites with mocked boundaries first, then typecheck/full tests/build/diff checks. Use the repository's supported FFmpeg for synthetic-video checks. Do not enable live authorization to make an offline test pass.
