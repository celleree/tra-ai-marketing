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
