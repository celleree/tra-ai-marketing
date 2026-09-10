# Image Generation Improvement

Last updated: 2026-09-10
Status: Active workstream checkpoint
Base staging SHA when this checkpoint was created: `86868f01f6e346bde2366a8d1fb01197fa727e6d`

Use this file to resume the current image-generation improvement work in a new ChatGPT/Codex session. It is a checkpoint, not a replacement for runtime code or `docs/image-workflow.md`.

## Goal

Build a repeatable TRA static-image system that can generate 30+ genuinely different Meta ads, not headline swaps, recolors, person swaps, or minor layout changes.

Validate the system at 6 creatives first, then 12, then 30+.

## Target responsibility split

### GPT-6 Astra: creative planner / director

Astra should receive the broad decision context:

- user campaign direction and hard constraints;
- approved TRA company knowledge;
- brand guidelines;
- guardrails and approved claims;
- uploaded TRA/reference material;
- Reference Library angle metadata;
- reusable Reference Library layout blueprints and visual mechanisms;
- winning-creative/performance metadata when available;
- the rest of the planned batch so it can optimize diversity globally.

Astra should decide what each ad is: angle, hook, message, reference relationship, visual mechanism, subject, environment, composition, treatment, text density, CTA treatment, and visual direction.

### GPT-Image-2.5 Sunburst: renderer

Sunburst should receive a distilled render brief for one creative, not the entire broad company-context dump again.

The render brief should contain only what is needed to execute that image:

- exact planned copy grounded only in approved TRA claims/source material; rendering does not itself approve the copy or creative for advertising use;
- subject and environment;
- chosen composition/layout;
- visual mechanism;
- image treatment;
- text hierarchy/density and CTA treatment;
- relevant TRA brand styling;
- aspect ratio / placement;
- hard compliance restrictions;
- safe-zone and deterministic-logo reservation rules;
- human-photorealism direction when applicable;
- chosen layout reference image when the validated workflow calls for one.

## Reference-system decisions

### Angle and layout are separate choices

A reference can contribute an angle, a layout, both, or neither.

If a reference supplies the chosen angle, its own layout is the preferred starting candidate, but it is not mandatory. Astra may instead use another reference layout or an original layout when that produces a stronger or more diverse concept.

Each planned concept should explicitly record:

- `angleSource`;
- `layoutSource`;
- `referenceRelationship: matched | mixed | original`.

### User-provided references get priority, not exclusivity

A user-supplied reference should materially influence the batch when relevant, but it must not force every output to imitate the same creative.

A batch may include:

- a close strategic/layout adaptation of the supplied reference;
- the same angle with a different layout;
- a different angle using the supplied layout;
- other library-derived concepts;
- original concepts.

### Third-party references are inspiration, not factual or identity sources

Do not transfer third-party branding, logos, trademarks, exact copy, claims, pricing, testimonials, statistics, proof, or person identity.

For the current manual experiment, the chosen external image may be supplied to Sunburst as layout/structure inspiration only. Whether this becomes the production path depends on the render test.

## Human decision

The desired system supports two human modes:

1. If an approved TRA human source is supplied, Astra may plan concepts using that person and the renderer may preserve that visible identity.
2. If no approved TRA human source is supplied, Astra may still plan a human concept when strategically useful, but the person must be an entirely fictional adult and must not copy or resemble a specific reference person.

For fictional humans, the render brief should favor ordinary photographic realism: natural facial proportions and slight asymmetry, realistic skin texture, natural eyes and hair, believable posture and hands/body, real-world lighting and shadows, and an ordinary environment. Avoid plastic skin, beauty-retouched stock-photo stiffness, glassy eyes, malformed anatomy, cinematic over-polish, or an obvious AI-rendered look.

Do not force every concept to use a person. Human and non-human concepts should compete on creative strength.

## Intended Astra concept contract

The app should move toward a structured concept record containing at least:

- `angle`
- `angleSource`
- `layoutSource`
- `referenceRelationship`
- `hook`
- `mainMessage`
- `visualArchetype`
- `visualMechanism`
- `subject`
- `environment`
- `composition`
- `imageTreatment`
- `textDensity`
- `ctaTreatment`
- `visualDirection`

## Intended Reference Library metadata

Each reusable Reference Library item should eventually cache planning data including:

- `referenceId`
- `angle`
- `layoutBlueprint`
- `visualMechanism`
- optional notes/tags

The reusable layout description should preserve the useful design mechanism and geometry rather than only a generic layout family. Important dimensions can include hierarchy, normalized regions/proportions, subject placement/scale/crop, camera/action direction, foreground/background relationships, negative space, overlap/layer order, focal path, image/text balance, CTA placement, typography feel, and spacing.

## Batch-diversity target

Astra should optimize diversity across the whole batch, not merely make each concept individually valid.

Meaningful variation can come from:

- strategic angle;
- layout family;
- visual mechanism;
- subject type;
- human vs non-human execution;
- composition;
- image treatment;
- text density;
- typography hierarchy;
- CTA treatment.

For exploratory batches, maximize meaningful strategic-angle diversity when strong relevant options exist. Do not repeat an angle merely to fill the batch, but do not choose weak or irrelevant angles solely to satisfy diversity.

Rendered diversity must eventually be evaluated as well; metadata differences alone do not prove that the images look different.

## What has been validated manually

A Playground test used 10 intentionally diverse external reference creatives (`TEST_REF_01` through `TEST_REF_10`) with cached-style metadata for angle, layout blueprint, and visual mechanism.

Astra produced a six-concept batch that demonstrated:

- materially different visual mechanisms;
- multiple strategic angles;
- matched reference relationships;
- a mixed angle/layout relationship;
- an original layout;
- a fictional-human concept with detailed photorealistic direction.

This was strong enough to move from planner testing to render testing. It does not yet prove production behavior or 30-ad diversity.

## Selected six-concept render mapping

Use the selected Astra concept batch with these layout assignments for the current manual render test:

- Concept 1 -> `TEST_REF_05`
- Concept 2 -> `TEST_REF_04`
- Concept 3 -> `TEST_REF_02`
- Concept 4 -> `TEST_REF_03`
- Concept 5 -> `TEST_REF_08` (the split-comparison reference)
- Concept 6 -> original layout / no reference image

Important labeling correction from the Codex fixture discussion: `TEST_REF_08` is the split-comparison creative; the educational headline-over-lifestyle/family-photo creative is `TEST_REF_09`.

## Current manual render experiment

This six-image behavior-discovery test is explicitly authorized by the narrow manual-test exception in `docs/image-workflow.md`. It does not change current app/runtime source-role or human-source rules.

Render one selected concept at a time with GPT-Image-2.5 Sunburst.

For concepts 1-5, pair the distilled render brief with the assigned layout reference image. Tell the renderer explicitly that the image is for composition/structure inspiration only and must not transfer third-party identity, people, branding, logos, exact copy, claims, prices, statistics, testimonials, or proof.

Concept 6 is the original-layout control and should receive no external layout reference.

Do not build the larger A/B/C harness, skeleton-generation system, or production changes before this small render test answers the basic question.

### Evaluate each output for

- concept fidelity;
- layout usefulness/fidelity without cloning;
- visual quality;
- mobile readability and text hierarchy;
- TRA brand fit;
- compliance;
- human realism when applicable;
- obvious visual distinctness from the rest of the batch.

Primary question: can someone look at the rendered batch without reading all the copy and immediately tell that these are different creative concepts?

## Production changes to make if the manual test succeeds

1. Cache richer `layoutBlueprint` and `visualMechanism` data for Reference Library items.
2. Pass Reference Library angle + reusable layout information to Astra, rather than only thin selection guidance.
3. Let Astra choose angle source and layout source independently and record `matched | mixed | original`.
4. Expand the Astra output schema to preserve the full creative/render contract.
5. Introduce a clean distilled Astra -> Sunburst render package instead of passing the full broad company context to the renderer again.
6. If validated by the manual test, allow the chosen layout reference image to reach Sunburst as layout-only inspiration under explicit third-party-content restrictions.
7. Update the current production human-source boundary so fictional adult humans are allowed when strategically useful, while preserving the separate approved-TRA-identity path.
8. Strengthen batch-level diversity checks and later add rendered-diversity evaluation appropriate for 12-30+ batches.

## Current production/staging differences to remember

Do not confuse the manual experiment decisions with current runtime behavior.

At this checkpoint, the app still differs from the target in important ways:

- the production planner currently uses Astra with medium reasoning;
- current runtime rules prohibit invented humans when there is no approved TRA human source;
- external layout/reference pixels are not currently attached to final image generation;
- the renderer receives broad company/user context again in addition to Astra's planned creative brief;
- Reference Library selections do not yet provide Astra the rich reusable angle + layout contract validated manually;
- existing safe-zone rules and deterministic server-side TRA logo compositing should be preserved.

Confirm current code before implementation because runtime behavior is authoritative and may have changed since this checkpoint.

## Exact next action

Complete the six-image Sunburst render test above. Review the outputs before deciding the exact production implementation.

If the six-image test is strong, validate 12 creatives next, then audit/planning-test 30+ before assuming the system scales.

## Related canonical sources

After this checkpoint, load only the narrow sources needed for the task:

- `docs/image-workflow.md` for active Stage 1 image architecture/direction;
- `docs/agent-workflow.md` for planning, review, handoff, or coordination;
- relevant runtime code/tests for actual implemented behavior;
- `AGENTS.md` for repository-wide rules and source-of-truth precedence.
