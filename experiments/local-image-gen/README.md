# Local Image Generation Experiment

## Purpose

Evaluate whether local image generation can improve TRA AI Marketing on quality, control, cost, or workflow flexibility enough to justify further investment or future integration.

This is an R&D experiment, not production architecture.

## Source of truth

TRA product requirements remain in [`docs/image-workflow.md`](../../docs/image-workflow.md). Do not duplicate or redefine those requirements here.

## Initial comparison

Compare local generation workflows against the current managed image-generation approach, especially GPT Image 2, using the same or equivalent TRA inputs where practical.

## Success criteria

A local workflow is worth continuing only if it shows a meaningful advantage in one or more of these areas without unacceptable regressions elsewhere:

- human identity/reference fidelity;
- photorealism;
- ad-ready composition and layout control;
- prompt adherence;
- meaningful creative variation;
- editing/inpainting/control;
- generation speed;
- generation cost;
- reproducibility and operational complexity.

## Out of scope for the first experiment

- production integration;
- replacing GPT-5.6 Sol;
- running a production GPU server;
- large-scale model training;
- maintaining many models at once;
- committing model weights, generated media, caches, or private TRA inputs to Git.

## Experiment files

- `environment.md` — local hardware/software setup.
- `models.md` — exact models/checkpoints tested and why.
- `workflows/` — exported ComfyUI workflow JSON and workflow notes.
- `prompts/` — reusable test prompts and input definitions.
- `evals/results.md` — comparable results and durable conclusions.

## Current status

Setup not yet recorded. No model or workflow has been selected as a TRA candidate yet.

## Decision rule

Keep the experiment small. Test one concrete TRA capability at a time. Promote only durable conclusions; routine debugging and abandoned experiments do not belong in canonical project documentation.
