# Architecture

TRA AI Marketing is a Next.js + TypeScript application for creating and evaluating static Meta ad creatives.

## Core boundaries

- The application UI and API routes live in this repository and deploy on Vercel.
- Production media and reference-library assets are stored in Cloudflare R2; local development can use local storage.
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

## Creative workflow

The app supports three generation paths:

- **TRA source ad:** analyze the uploaded TRA ad for brand/content context, choose separate reference-library creatives for visual execution, then generate new TRA ads.
- **Reference ad:** analyze an outside ad as creative inspiration, then create original TRA adaptations without copying third-party identity or unsupported claims.
- **Text only:** create original TRA concepts from user direction without a source image.

The exact generation prompts, creative categories, formats, model defaults, validation rules, and selection behavior live in source code and should not be duplicated here.

## Knowledge and guardrails

Only concise, reusable business knowledge belongs in the repository. Customer-review patterns are summarized in `knowledge/customer-insights.md`; raw review data remains in its external source and is retrieved only when exact evidence is needed.

## Change policy

This document records stable boundaries, not feature status. Current work belongs in GitHub Issues, implementation detail belongs in code, and historical decisions/removals belong in Git history.
