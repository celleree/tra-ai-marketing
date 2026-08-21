# Roadmap

## Phase 1 - Foundation

Build the TRA knowledge base from approved internal material.

Needed inputs:
- Brand guidelines
- Approved copy
- Approved offers
- Required disclaimers
- Compliance rules
- Existing winning TRA ads
- Known bad claims or wording to avoid
- Notes from marketing and media-buying teams

## Phase 2 - Static Creative Workflow

Create a repeatable workflow:

Reference ad or concept -> AI analysis -> TRA adaptation -> multiple static variations -> automated QA -> human selection

Also support video-to-image repurposing:
- Accept one source video.
- Extract or generate roughly 10-20 useful static image candidates from strong moments in the video.
- Use those images as ad creatives or creative references.

## Phase 3 - Quality Control

Check generated work for:
- Incorrect claims
- Brand mismatch
- Spelling or text errors
- Missing required disclaimers
- Duplicate or near-duplicate concepts
- Unclear CTA or offer

## Phase 4 - Meta Data Connection

Connect approved Meta reporting data so the AI can answer questions such as:
- What is working?
- What changed?
- What needs attention?
- Which creatives should we test more?
- Which ads are spending without enough results?

Measurement requirement:
- Every generated image creative must have a unique, persistent creative URL tied to its internal creative record.
- Preserve the relationship between that URL, the R2 media object, and any later Meta image hash, creative ID, and ad ID.
- TRA calculates ROI in an external system rather than from a Meta ROI field, so the unique creative URL must be available as a durable creative-level reference for joining external revenue/ROI data back to the exact image creative.
- Do not use temporary browser URLs or expiring links as the attribution key.

Start read-only.

## Phase 5 - Media-Buyer Assistant

Turn raw metrics into concise recommendations and repeatable daily/weekly analysis workflows.

## Phase 6 - Autonomous Static Ad Flywheel

After validation, allow the agent to continuously manage only approved static-image ads and their copy.

Target loop:

Create -> Launch -> Measure -> Learn -> Pause Losers -> Replace -> Repeat

The agent should be able to:
- Generate and launch new static image creatives and copy inside approved campaigns/ad sets.
- Give each ad enough time and data before judging performance.
- Keep strong performers running.
- Pause underperforming ads rather than deleting them so performance history is preserved.
- Replace weak ads with new concepts or variants.
- Store performance learnings and use them to improve future creative decisions.
- Run continuously with minimal human involvement once the workflow has been validated.

Hard restrictions:
- Existing video ads are off-limits unless TRA explicitly opts them into automation later.
- The agent may only modify specifically approved static-image campaigns/ad sets.
- Spending changes should remain inside predefined limits.
- Human review should remain available, especially during initial rollout and for image quality.

Additional scale steps:
- Automate recurring analysis.
- Connect CRM and revenue data.
- Prepare for higher-quality AI video workflows when TRA decides the quality/risk is acceptable.

## Production Security Readiness

Complete this checklist before the TRA app is treated as production-ready or exposed broadly.

### Release blockers

- **Application authentication and authorization:** protect `/studio` and all privileged API routes. Meta account/page access, Meta publishing, OpenAI-backed generation/analysis, R2 uploads, reference-library mutation, company data mutation, and font mutation must require an authenticated and authorized TRA user. Do not rely on a private GitHub repository as application access control. Verify whether Vercel Deployment Protection is enabled, but do not treat platform preview protection as a replacement for application authorization.
- **Rate limits and usage quotas:** add server-side rate limiting/quotas to expensive or privileged endpoints, especially creative generation, website analysis, reference classification, uploads, and Meta publishing. Enforce the existing 4,000-character creative-context limit server-side as well as in the browser. Keep server-side caps on creative counts/batch sizes.
- **R2 direct-upload size enforcement:** do not trust the browser-declared upload size alone. Ensure the actual object size is bounded before reading the full object into application memory during confirmation/validation. Keep short-lived presigned URLs and signed content types.

### Hardening before production

- **Website-analyzer DNS rebinding defense:** current SSRF controls reject private/local IPv4 and IPv6 addresses, validate redirects, limit crawl size, and use timeouts. Harden further so the address actually connected to cannot change from an approved public DNS result to a private/internal address between validation and fetch.
- **Security headers:** add an explicit production header policy, including an appropriate Content Security Policy, clickjacking protection (`frame-ancestors` and/or equivalent), Referrer-Policy, Permissions-Policy, and other relevant browser-security headers. Verify HTTPS/HSTS behavior at the deployment layer.
- **Font content validation:** brand-font uploads currently have generated safe filenames and size/extension validation. Add file-signature/structure validation so uploaded content must actually match an allowed WOFF2/WOFF/TTF/OTF format.

### Production verification

- Keep GitHub repository visibility private.
- Keep OpenAI, Meta, and R2 credentials server-only; never expose them through `NEXT_PUBLIC_*` variables or browser payloads.
- Keep `.env`/credential files excluded from source control and rotate credentials if any secret is ever committed or exposed.
- Keep production R2 CORS limited to exact approved app origins; do not use wildcard origins for the production bucket.
- Use least-privilege Meta and R2 credentials where practical.
- Re-run dependency/security-advisory checks before production releases and keep Next.js/React/AWS SDK dependencies on patched versions.
