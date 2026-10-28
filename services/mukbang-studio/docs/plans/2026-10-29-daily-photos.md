# Daily Photos Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use the available executing-plans skill locally; no delegation or unavailable finishing tools.

**Goal:** Complete the two remaining real-photo categories without changing the existing eating video or the single subtitled story.

**Architecture:** Optional `photos_enabled` adds `daily_photos` to the same visual response. Each of portrait/ugly_cute selects one distinct sampled source frame or explicitly reports absence. Local evidence validation and original-resolution PNG export are independent from video successes, with separate timings and historical compatibility. No image generation, no extra AI call or implicit retry.

**Tech Stack:** Existing Python/FastAPI, FFmpeg, Pillow, pytest, vanilla JS and node:test; existing local browser runtime for read-only QA.

---

## Confirmed design

User requested the remaining two photo categories after accepting the single original-sound + inner-monologue story. Portrait: human and cat recognizably share a pleasant composition; prefer visible human face, not a stray hand as portrait. Ugly-cute: close face/nose, silly full face, tongue, tiny teeth, or a genuinely funny expression; not random blur or obstruction. One best photo per category by default, no forced quota if material does not qualify. Keep original frame and expose why/time/evidence. Both categories must be independently usable even when a video fails.

Alternatives: separate photo inference adds cost; generic reuse of eating keyframes misses portrait criteria. Choose one shared request with an additive independent contract. Existing approved eating/style prompts stay byte-exact.

## Task 1 — Model contract and validation

- Create `prompts/daily-photos-system-appendix.txt`, `mukbang/photos.py`, `tests/test_photos.py`.
- First run validator tests expecting a missing module; then implement strict status, known frame, finite source time and category evidence checks. Missing/invalid differs from not_found; duplicate categories do not silently become two photos.
- Modify `vision.py`, `pipeline.py`, `server.py`: optional strict bool default false; require story mode for photo bundle; legacy effective options/fingerprints unchanged. Test one call, no-photo compatibility, invalid-photo isolation and four product states.

## Task 2 — Real source frame export

- Export selected exact source-frame indexes together in one FFmpeg decoding pass to native-resolution PNG, no resize/crop/enhancement. Verify source-PTS identity, files, dimensions and hashes. Save `photo-decision.json`, `photo-result.json` with source and output evidence.
- Modify `daily_outputs.py` to export after videos, count independently deliverable products and record `export_photos`; preserve original raw model output. Modify `timing.py` and offline `recovery.py`; never request AI during recovery.
- Add actual-media tests checking exact selected frame, dimensions, independent failure and cancellation.

## Task 3 — Existing phone UI

- Replace only photo placeholders in `web/daily.html`, `daily.js`, `daily.css`; retain video layout and warmer paper colors. One real photo card per category, original aspect ratio, full-image opening/download, source time and reason. Empty/pending/not_found/invalid/failed/historical are explicit.
- New uploads request all four products. Reject old unsupported backend before upload. `scripts/test_daily_frontend.cjs` tests safe URLs/plain-text model output, missing history, capability checks and one submission.

## Task 4 — Verify and archive

- Run focused pytest/JS suites, then full regressions.
- Existing8881 has no running jobs, but restart was blocked by environment policy. Preserve it and launch independent8882 with `data/daily-photos/` and an explicit P0004 library snapshot. Create a new task from the current user sample, one actual visual call, preserve the accepted previous task. Inspect exported photos and phone/desktop image and video loading. If unsupported pictures cannot be found, report honestly; no automatic inference retry.
- Update README/API/method docs and store prompt/code on GitHub main without force. Exclude all user media, data, logs and credentials.

## Acceptance

- [x] Two videos plus two independent photo categories from one visual request.
- [x] Strict source evidence, original-resolution images, explicit absence/failure, no fake historical photos.
- [x] Photo timings, working phone downloads and inspectable reasons/timestamps.
- [x] Tests and real sample QA complete, private artifacts excluded from Git archive.

Execution result: new8882 task534c4840064d has40s eating,35s story, native2560×1440 ugly-cute photo at52s; portrait honestly not_found, not a second fake photo. One visual request; local photo export6.531s. Full regression783 pass/2 skip followed by24 focused photo checks; frontend88 pass; read-only desktop/mobile playback/image QA passed. See `../daily-photos-2026-10-29.md` for detailed limits and verification.
