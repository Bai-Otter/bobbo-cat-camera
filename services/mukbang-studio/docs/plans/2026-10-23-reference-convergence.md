# Audited reference convergence implementation plan

**Goal:** Prevent redundant out-of-interval frame references from aborting otherwise supported selections, without widening the approved footage, re-running AI, or hiding the original decision.

**Architecture:** Keep raw validation strict. The deterministic export path may remove only known, AI-selected references outside the existing approved context (highlight) or existing clip (meme). Every interval must still contain an original cited frame. Save the original AI response unchanged, expose each removal in adjustments and warnings, and retain all feedback and source-frame checks.

**Tech stack:** Python, pytest, existing FFmpeg renderer and offline recovery CLI.

## Evidence and choice

Latest failure `5605252b554c` completed one vision request, then failed selection because `F0086=84.991667` was cited for context `[85,91)`. Both memes also have redundant early references, alongside valid remaining references. Repeating the request or adding more prompt rules is not a deterministic repair. Moving the boundaries would approve footage the model did not approve. Audited removal of redundant references preserves the requested edit and is the chosen fix.

## Task 1: Selection regression and implementation

- Add failing tests for exact half-open boundaries, highlight context handles, meme boundaries, unchanged inputs, audit visibility, and original clips/selected frames.
- Unknown IDs, unselected references, invalid data, and clips without cited evidence inside the clip must still fail.
- Implement audited convergence only in `validate_and_adjust`; `validate_result` remains strict.
- Revalidate the converged result with the strict validator.

## Task 2: Pipeline regression

- Verify the ordinary pipeline still makes one AI call and preserves the original raw/parsed response.
- Verify removals appear in result warnings/adjustments.
- Verify a raw disliked reference is rejected before any normalization, including one outside its clip/context.

## Task 3: Evidence-preserving offline recovery

- Accept selection-stage failures only when the existing completed-response evidence chain and deterministic validation succeed.
- Preflight unrecoverable selections before creating an output task where possible.
- Keep incomplete responses, unknown IDs, feedback iterations and inconsistent artifacts fail-closed; retain source integrity checks and zero-call provenance.

## Task 4: Verification and deployment

- Run targeted regressions, full Python tests, existing frontend tests, syntax and diff checks; independently review the change.
- Back up and sync only changed code after confirming no active jobs or prompt proposals. Do not replace data, secrets, environment or the published aesthetic prompt.
- Recover the latest failed task into a new output without AI calls, validate media, restart the service, verify the new task and preserve all historical artifacts.
- Document evidence and synchronize the fix to the requested repository.
