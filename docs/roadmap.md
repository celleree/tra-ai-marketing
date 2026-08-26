# TRA AI Marketing Roadmap

## Purpose

Build a production-grade AI marketing system for TRA that can create high-quality static ads, learn from verified revenue performance, and eventually manage approved static-ad campaigns within deterministic safety constraints.

The roadmap is staged deliberately. Do not skip ahead into autonomous campaign management before the creative system, identity/metadata layer, QA, and verified performance data are trustworthy.

## Source-of-truth structure

- `docs/roadmap.md` — staged product roadmap and ordering.
- GitHub Issues — current implementation work, acceptance criteria, and deferred tasks.
- `docs/architecture.md` — stable system boundaries and model roles.
- Source code/config — runtime behavior and schemas.
- TRA project source files — approved company knowledge, brand guidelines, and guardrails.

## Testing principle: web apps first, APIs later

Until TRA provides the required Claude/API access and there is a reason to incur API cost, validate the intended multi-model workflow manually in the Claude and ChatGPT web apps.

Manual web-app tests are prototype/behavior-discovery work for the future API architecture. They are not throwaway work, but they must be revalidated when the same workflow is later implemented through APIs.

Use the web apps to validate:
- Claude strategy and orchestration behavior;
- GPT-5.6 Sol creative-direction and prompt-building behavior;
- GPT Image 2 visual execution;
- company-profile grounding;
- reference selection and dimensional variation planning;
- QA/review handoffs between models;
- the shape of structured briefs, fingerprints, and review outputs.

Do not spend personal API money merely to prove behavior that can be tested manually in the web apps.

---

# Stage 1 — Production-Ready Creative System

This is the active build until creative quality, persistent identity/metadata, and QA are reliable.

## 1A. Company intelligence and model grounding

Create one durable company-profile system that both Claude and GPT-5.6 Sol can use.

The profile must include:
- TRA knowledge base;
- brand guidelines;
- guardrails and compliance constraints;
- approved claims and offers;
- required disclaimers;
- customer problems, desires, objections, personas, and trust themes;
- approved visual assets and logo rules;
- brand colors and typography guidance;
- relevant campaign/business context.

Requirements:
- Claude can review the complete profile before making strategic decisions.
- GPT-5.6 Sol can review the complete profile before building creative briefs/prompts.
- Retrieval may be condensed/structured for efficiency, but neither model should operate from only logo/colors/fonts.
- Unsupported claims remain unknown rather than being inferred.
- Deterministic compliance rules remain outside model discretion where practical.

## 1B. Persistent creative identity and file/data structure

Every creative concept must receive durable identity and metadata before later performance automation depends on it.

Store at minimum:
- concept-level Creative ID;
- media/asset IDs for each rendered format;
- source type and source/reference identity;
- parent/child lineage for variations;
- angle;
- persona;
- pain point;
- desired outcome;
- awareness stage where relevant;
- emotional framing;
- hook/message;
- offer/CTA framing;
- `SO WHAT?` chain;
- visual mechanism/style;
- subject and environment;
- layout/composition;
- image/text balance and copy structure;
- aspect ratio / placement;
- model/version context;
- generation brief/prompt metadata needed for reproducibility;
- QA/review results;
- approval state;
- lifecycle state;
- later Meta IDs and revenue/performance attribution.

Rejected and paused creatives should be retained as learning data rather than deleted.

## 1C. Creative strategy and dimensional variation planner

Move beyond `one reference -> one remake`.

A reference is a creative blueprint, not a template to clone. Extract useful design logic such as:
- layout;
- hierarchy;
- composition;
- spacing;
- text density;
- image/text balance;
- CTA placement;
- visual mechanism;
- typography feel;
- photography/illustration treatment.

Before generating a batch, plan intentional dimensional differences.

Strategic dimensions can include:
- angle;
- persona;
- pain point;
- desired outcome;
- awareness stage;
- emotional framing;
- hook/message;
- offer/CTA framing.

Execution dimensions can include:
- visual archetype;
- subject;
- environment;
- composition;
- layout;
- image treatment;
- photography/illustration style;
- text density;
- copy structure;
- CTA treatment;
- typography hierarchy.

The planner should favor variations that amount to genuine creative hypotheses and meaningful visual changes rather than cosmetic edits. Use Meta/Andromeda major-change thinking as the practical standard: new concepts should differ materially enough that they are not simply headline swaps, recolors, or near-duplicates.

Preserve exploration. A batch should not collapse into several versions of the same idea.

## 1D. Multi-model creative handoff

Target role split:

### Claude — strategist / orchestrator

Claude decides what the system needs to test.

Claude should:
- review the company profile;
- review available references and previous creative context;
- choose the reference or references to use;
- choose the best angle(s) and hypotheses;
- build the `SO WHAT?` chain;
- choose dimensional variations;
- choose the number of concepts and requested placement variants;
- hand structured creative direction to GPT-5.6 Sol.

### GPT-5.6 Sol — creative director / prompt builder / visual QA

Sol converts Claude's strategic direction into execution-ready creative briefs.

Sol should:
- review the company profile;
- translate each hypothesis into a clear visual concept;
- preserve the useful blueprint of the selected reference without copying third-party identity;
- write structured GPT Image 2 instructions;
- control hierarchy, spacing, imagery, typography, CTA treatment, logo-safe space, realism, and mobile readability;
- review generated output against the brief and QA rules;
- request regeneration/correction when needed.

### GPT Image 2 — image-generation engine

GPT Image 2 produces the visual asset from Sol's direction.

The image model should not be responsible for strategic decision-making, compliance policy, or final QA authority.

## 1E. Placement and format generation

Treat one concept as a family of placement variants, not unrelated creatives.

Support, according to campaign need:
- 9:16 — Stories / Reels;
- 4:5 — vertical Feed;
- 1:1 — square Feed;
- horizontal Feed/other supported placements when needed.

Requirements:
- keep one concept-level Creative ID across format variants;
- allow format-specific composition rather than naive cropping;
- maintain safe zones, text hierarchy, CTA readability, and logo placement for each aspect ratio;
- record which formats/placements were requested and generated;
- do not automatically generate every format when Claude determines only a subset is needed.

## 1F. Exact logo handling

- Never ask an image model to recreate the TRA logo.
- Use the approved TRA logo asset as the single source of truth.
- Composite the actual logo deterministically after generation.
- Allow proportional resizing only.
- Preserve artwork, colors, spacing, and aspect ratio.
- Maintain logo-safe placement in the generated composition.
- Regenerate when no acceptable logo-safe placement exists.

## 1G. QA, checks, and balances

Use models with distinct roles rather than overlapping model soup.

Primary checks:
- Claude — strategic fit, hypothesis quality, relevance to campaign need, company-profile alignment;
- GPT-5.6 Sol — visual execution, prompt adherence, design quality, realism, typography/readability, reference fidelity without copying;
- deterministic code — hard compliance, schema, identity, placement, file, spend, and execution rules where possible.

A second creative/logical reviewer may be introduced when tests show measurable value, but it should have a clearly defined responsibility. Do not add models solely for redundancy.

QA must check at minimum:
- brand fit;
- exact logo handling;
- logo-safe area;
- compliance/guardrails;
- unsupported claims;
- required disclaimers when applicable;
- text spelling/readability;
- hierarchy and spacing;
- image realism / human artifacts;
- CTA clarity;
- intended aspect ratio and placement;
- reference adaptation quality;
- duplicate/near-duplicate risk;
- dimensional-diversity requirements;
- overall professional-design quality.

Failed creatives should be rejected/regenerated or surfaced explicitly for human review.

## 1H. TRA Creatives library

Finish the internal creative library so every accepted concept survives refresh/redeploy and can later be joined to performance.

Support:
- concept-level Creative ID;
- all format variants;
- source/reference provenance;
- creative fingerprint;
- copy;
- QA history;
- approval: pending / approved / rejected;
- lifecycle: draft / queued / testing / scaling / paused;
- regenerate;
- create variation;
- parent/child lineage;
- Meta attribution fields;
- future performance/revenue fields.

## 1I. Web-app validation gate

Before paying for or wiring the final multi-model API chain, manually validate the workflow in Claude web + ChatGPT web.

Test small controlled batches for:
- Claude reference/angle/variation decisions;
- Claude -> Sol brief quality;
- Sol -> GPT Image 2 prompt quality;
- reference blueprint extraction;
- dimensional diversity;
- placement variants;
- company-profile grounding;
- QA disagreements and reviewer value;
- regeneration behavior;
- whether the final assets are close to professional designer output.

Capture only durable conclusions, schemas, and rules from these tests. Do not store raw model chain-of-thought.

## 1J. Production security and release readiness

Before broad production use:
- authentication/authorization for Studio and privileged APIs;
- protect OpenAI, Meta, R2, reference mutation, company-profile mutation, and other privileged actions;
- rate limits/quotas;
- upload-size/type/signature enforcement;
- browser-security headers;
- SSRF/DNS-rebinding defenses for website analysis;
- least-privilege credentials;
- production R2 CORS restrictions;
- dependency/security verification;
- CI/build/test verification.

---

# Stage 2 — Verified Performance System

Do not begin this stage until Stage 1 is reliable and TRA provides the required data/account access.

## 2A. Verified Meta + revenue data

Connect read-only performance data first.

Build a verified relationship between:
- internal Creative ID;
- format/media ID;
- persistent creative URL;
- Meta image hash;
- Meta Creative ID;
- Meta Ad ID;
- campaign/ad-set identity;
- delivery/spend/results;
- TRA downstream revenue/ROI identity.

Normalize and validate:
- timezones;
- attribution windows;
- currency;
- duplicates;
- delayed conversions;
- missing/stale records;
- source-of-truth metric calculations.

Revenue is the north-star business objective. CTR, CPC, CPL, CPA, ROAS, conversion rate, and similar metrics remain diagnostic unless explicitly promoted to a hard business rule.

## 2B. Claude read-only strategist

Give Claude narrow read-only access to verified data and creative history.

Claude should:
- identify winners/losers and uncertainty;
- diagnose likely causes;
- detect fatigue/patterns;
- propose new hypotheses and reference/angle choices;
- preserve exploration and exploitation;
- choose `do nothing` when evidence is insufficient;
- log recommendations, evidence, hypotheses, and eventual outcomes persistently.

No Meta mutation is required in this stage.

---

# Stage 3 — Supervised Execution

Only after read-only strategy quality and data integrity are validated.

Claude may propose controlled actions such as:
- launch an approved static creative/test;
- pause an ad;
- make an approved allocation/budget change.

A human approves material actions before execution.

Deterministic validators outside the model enforce:
- allowed campaigns/ad sets;
- spend ceilings;
- maximum budget change;
- minimum evidence/sample requirements;
- attribution freshness;
- cooldowns;
- compliance eligibility;
- duplicate/pending-action protection;
- idempotency;
- API/rate-limit handling;
- explicit `do nothing` support;
- kill switch / emergency freeze.

---

# Stage 4 — Bounded Autonomous Static-Ad Flywheel

After supervised execution is demonstrably reliable, allow well-understood low-risk actions to run automatically inside hard boundaries.

Target loop:

`verified Meta + TRA revenue -> Claude strategy/hypothesis -> Sol creative direction -> GPT Image 2 -> QA -> approved/validated launch -> measurement -> persistent learning -> scale/pause/replace -> repeat`

Preserve these permanent principles:
- no artificial campaign end date;
- optimize for verified attributable revenue over the long term;
- hard spending/compliance/attribution rules live outside the LLM;
- intermediate metrics are diagnostics, not the objective;
- preserve exploration as well as exploitation;
- every action is auditable;
- every creative remains tied to persistent identity and metadata;
- failures involving spend/publishing fail closed;
- autopilot can be disabled immediately;
- existing video ads stay out of autonomous control unless explicitly opted in later.

---

# Current priority

Work only on Stage 1 until the production-ready creative system is reliable.

Immediate order:
1. establish the complete company-profile/model context contract;
2. expand the CreativeRecord / creative-fingerprint / placement-variant schema;
3. validate Claude -> GPT-5.6 Sol -> GPT Image 2 manually in web apps;
4. implement dimensional variation planning;
5. implement placement-aware format generation;
6. implement Sol/Claude QA plus deterministic checks;
7. finish the TRA Creatives lifecycle/library;
8. complete production security/readiness;
9. wait for TRA data/API/account access before Stage 2.
