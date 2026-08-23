# Architecture

TRA AI Marketing is a Next.js + TypeScript application for creating and evaluating static Meta ad creatives.

## Core boundaries

- The application UI and API routes live in this repository and deploy on Vercel.
- Production media and reference-library assets are stored in Cloudflare R2; local development can use local storage.
- OpenAI provides creative analysis, copy generation, and image generation through server-side API calls.
- Meta integration is server-side and may create new advertising objects only within the safety behavior implemented in code. Runtime behavior is authoritative in `lib/meta/` and the relevant API routes.
- Generated creatives have persistent internal/media identity so later Meta delivery and external revenue data can be joined back to the exact creative.

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
