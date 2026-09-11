# Architecture

TRA AI Marketing is a Next.js + TypeScript application for creating and evaluating static Meta ad creatives.

## Core boundaries

- The application UI and API routes live in this repository and deploy on Vercel.
- Production media and reference-library assets are stored in Cloudflare R2; local development can use local storage.
- Authenticated media delivery must not proxy production or Preview media bytes through Vercel Functions. Vercel may authorize and validate the request, then issue a short-lived signed redirect; Cloudflare R2 serves the actual media bytes.
- OpenAI provides creative analysis, copy generation, and image generation through server-side API calls.
- Meta integration is server-side and may create new advertising objects only within the safety behavior implemented in code. Runtime behavior is authoritative in `lib/meta/` and the relevant API routes.
- Generated creatives have persistent internal/media identity so later Meta delivery and external revenue data can be joined back to the exact creative.

## Delivery boundary

The system is intentionally built in two stages.

### Stage 1: creative system

Until TRA provides the required performance/revenue data, advertising-account access, and Claude access, implementation stays focused on producing high-quality static creatives rather than trying to optimize live advertising performance.

The current system should support:

- approved TRA knowledge, brand context, and compliance guardrails;
- reference-driven and original creative strategy;
- a `SO WHAT?` chain that connects surface messaging to meaningful customer outcomes;
- dimensional variation across angles, personas, messages, formats, layouts, and visual direction;
- image generation plus quality, compliance, and duplicate/similarity review;
- persistent creative identity and structured metadata sufficient to attach future spend, delivery, and revenue outcomes to the exact creative.

Do not treat winner prediction, custom ML training, autonomous media buying, budget optimization, automatic pause/scale decisions, or performance dashboards as current-stage requirements unless explicitly requested.

### Stage 2: performance system

After the required access exists, extend the creative system rather than replacing it:

1. Join verified Meta delivery/spend data and TRA revenue outcomes to persistent creative IDs.
2. Give Claude read-only access to verified data and experiment history for analysis, hypotheses, and recommendations.
3. Add supervised execution only after recommendation quality and data integrity are validated.
4. Add bounded automation only behind deterministic spending, compliance, attribution, and experimentation safeguards.

The long-term strategic horizon is ongoing rather than time-boxed. The agent should optimize for verified attributable revenue over the long term within hard business constraints. CTR, CPL, CPC, CPA, ROAS, and similar intermediate metrics are diagnostic signals unless a specific business rule explicitly promotes one to a constraint.

#### Preserved future-stage principles

These are durable design rules to preserve now and implement later; they do not expand the active Stage 1 scope.

- **Ongoing horizon, not a fixed end date.** The agent should behave as though it is building and improving a sustainable acquisition engine, not trying to maximize a short time-boxed experiment.
- **Revenue is the north-star objective.** Optimize for verified attributable revenue over the long term. Spending, efficiency, compliance, attribution, and experimentation limits remain hard constraints.
- **Intermediate metrics are diagnostic.** CTR, CPL, CPC, CPA, ROAS, conversion rate, and similar metrics help explain performance but should not silently replace the true business objective unless explicitly encoded as a business constraint.
- **`SO WHAT?` reasoning is required early.** Creative strategy should trace surface claims through functional and emotional outcomes so concepts are built around meaningful customer impact rather than shallow benefits.
- **Exploration and exploitation must coexist.** The system should build on demonstrated winners while continuously reserving capacity for substantially different angles, personas, messages, visual mechanisms, formats, and concepts.
- **Model roles stay distinct.** Claude is the advertising strategist/orchestrator; GPT-5.6 Sol is the creative director and visual QA layer; GPT Image 2 is the image-generation engine.
- **Hard rules live outside the LLM.** Financial controls, compliance rules, attribution checks, execution permissions, cooldowns, minimum-evidence requirements, and other safety constraints belong in deterministic code rather than depending on model judgment alone.
- **Verify data before reasoning.** Metrics should be normalized and validated by code before Claude uses them for recommendations or decisions.
- **Persistent identity connects creative to revenue.** Every creative, hypothesis, reference, and material generation attribute should remain tied to a persistent creative ID so future spend, delivery, and revenue can be joined back to the exact experiment.
- **Autonomy is progressive.** The intended rollout is verified data connection -> Claude read-only analysis/recommendations -> supervised execution -> bounded automation. Do not skip directly to unrestricted execution.
- **Taste is grounded externally.** Visual quality and brand taste should come from strong references, TRA brand context, accumulated winning patterns, and explicit heuristics rather than assuming a base model has the correct aesthetic by default.
- **Learnings belong in persistent system state.** Reusable heuristics, experiment outcomes, and successful/failed patterns should be stored in durable records and retrieved when relevant instead of living only in temporary model conversation history.

## Creative workflow

The app supports three generation paths:

- **TRA source ad:** analyze the uploaded TRA ad for brand/content context, choose separate reference-library creatives for visual execution, then generate new TRA ads.
- **Reference ad:** analyze an outside ad as creative inspiration, then create original TRA adaptations without copying third-party identity or unsupported claims.
- **Text only:** create original TRA concepts from user direction without a source image.

The exact generation prompts, creative categories, formats, model defaults, validation rules, and selection behavior live in source code and should not be duplicated here.

## Knowledge and guardrails

The video-intelligence prototype runs in local development: it retains source-bound analysis and inspection thumbnails under ignored `.runtime/video-intelligence`, reusing completed analysis for unchanged source bytes and analysis models. It explicitly rejects production use; production media storage continues to require R2. Semantic observations and speech overlap remain unverified context, never identity evidence or generation approval. Generation must obtain approved frames separately from the server-hydrated TRA video.

Only concise, reusable business knowledge belongs in the repository. Customer-review patterns are summarized in `knowledge/customer-insights.md`; raw review data remains in its external source and is retrieved only when exact evidence is needed.

## Change policy

This document records stable boundaries, not feature status. Current work belongs in GitHub Issues, implementation detail belongs in code, and historical decisions/removals belong in Git history.
