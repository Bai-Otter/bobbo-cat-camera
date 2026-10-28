# Close-up Photo Prompt Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use available skills; no delegation.

**Goal:** Generalize the user's accepted exaggerated close-up photo aesthetic and promote kissing/embracing into the best human-pet portrait.

**Architecture:** Refine only the gallery photo system appendix and matching user reminder; preserve gallery schema, one visual request, native export, current data store and existing eating/story prefixes. Frozen historical task prompts and outputs remain unchanged. Version the new text with `closeup-v2`, recorded inside each actual prompt.

**Tech Stack:** Existing Python/FastAPI, FFmpeg, pytest, vanilla HTML and read-only Playwright QA.

---

User has explicitly requested this implementation; their screenshot identifies positive close-up, secondary tongue, negative ordinary round/side face, and a kiss misclassified as ugly-cute. No clarification or model-weight training is needed.

## Choices

1. Recommended: reusable prompt refinement; keep original schema and saved evidence. The prompt is the requested preference carrier and can generalize beyond source timestamps.
2. Hardcode chosen times or move the old photo manually: rejected; would not improve new uploads.
3. Add another AI review or image-similarity pipeline: deferred; exceeds this correction and changes one-call cost.

## Steps

1. Add `tests/test_photo_prompt_refinement.py` checking new version, close-up-first exclusions, affectionate portrait priority, no fixed source IDs/times, preserved eating/story prompt prefix and unchanged legacy mode. Run red.
2. Update `prompts/daily-photo-gallery-system-appendix.txt` and matching reminder in `mukbang/vision.py`. Aim for4–6 qualifying photos with at least3 exaggerated closeups when available; allow at most1 clear tongue/teeth-only supplement. Never fill with ordinary frontal/side portraits. Permit distinct closeups from one action; disallow identical frames. Preserve explicit shortfall. Update `web/daily.html` explanatory copy, clearly describing new-generation rules. Run targeted Python and frontend tests.
3. Confirm8883 is idle and exact service PIDs/data directory, restart only that instance to load the new prompt, retaining P0004 library and historical hashes. Submit the same authorized source once into a new task; keep receipt to prevent retries. Check actual chosen photos and one-call count; no silent resubmission.
4. Verify native photo exports and browser downloads/playback; report real count/shortfall honestly. Save feedback-to-rule mapping, actual sample results and tests in docs; push code/prompts/docs only, never private media or credentials.

## Acceptance

- [x] Kiss/embrace preferred over merely feeding together:82s frame now portrait.
- [x] Four close-up photos, no ordinary round/side faces for variety.
- [x] Count target remains4–6; source limitations are disclosed, not hidden by filler.
- [x] Same endpoint/store and untouched old jobs; single inference. Story needed an explicit local0.4s caption timing correction, not an AI retry; original raw response and failure evidence retained.
- [x] Tests and visual QA complete; archive only code/prompts/docs, no private artifacts.
