# TRA AI Marketing

AI-assisted static-ad creation and Meta advertising workflows for Tax Relief Advocates (TRA).

The system focuses on producing meaningfully different static creatives, using approved TRA brand/compliance context, publishing reviewable Meta ads, and building toward performance-informed creative iteration.

## Local development

Requirements: Node.js 22.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Copy `.env.example` for local environment settings. Creative generation requires `OPENAI_API_KEY`. Production media storage uses Cloudflare R2; local development can use local media storage.

Useful checks:

```bash
npm run typecheck
npm run build
```

## Repository map

- `app/` — Next.js pages and API routes
- `components/` — application UI
- `lib/` — runtime logic, integrations, creative planning, and storage
- `assets/` / `public/` — approved static assets
- `knowledge/` — concise business/customer knowledge intended for selective AI use
- `docs/image-workflow.md` — active Stage 1 image-workflow product direction and implementation order; read this before older planning
- `docs/roadmap.md` — staged long-term/future product roadmap
- `docs/architecture.md` — stable system boundaries
- `docs/deployment.md` — external deployment/setup requirements
- `docs/agent-workflow.md` — detailed Codex planning/review/handoff/routing rules; load only when coordination work needs them
- `docs/parallel-coding.md` — parallel-agent rules; load only when parallel execution is being considered
- `.env.example` — canonical environment-variable names and examples
- `AGENTS.md` — concise repository-wide AI-agent map and invariant rules

When sources disagree, use this hierarchy:

1. Runtime code and tests define what is actually implemented.
2. `docs/image-workflow.md` defines the active Stage 1 image-product direction and intended architecture.
3. GitHub Issues are task-specific implementation specs underneath that direction. They override `docs/image-workflow.md` only when they explicitly record a newer product decision and state what they supersede.
4. `docs/roadmap.md` is long-term/future direction and does not override the active Stage 1 image workflow.

Do not restore old architecture from stale Issues, PR descriptions, roadmap text, or historical planning. The current active image-workflow model decision is GPT-6 Astra with medium reasoning for creative planning/prompting, followed by GPT Image 2 for generation; see `docs/image-workflow.md` for the full current contract.
