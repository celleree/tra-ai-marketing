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
- `docs/architecture.md` — stable system boundaries
- `docs/deployment.md` — external deployment/setup requirements
- `.env.example` — canonical environment-variable names and examples
- `AGENTS.md` — repository workflow and documentation/context rules for AI coding agents

Runtime behavior is defined by code/config. Current priorities and future work are tracked in GitHub Issues rather than duplicated in repository roadmap files.
