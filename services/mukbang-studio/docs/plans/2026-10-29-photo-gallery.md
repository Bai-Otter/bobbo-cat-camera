# Photo Gallery Correction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use available local skills, no delegation.

**Goal:** Correct portrait eligibility to any visible human part with the pet; return at least4 distinct ugly-cute photos when the material supports it, preserving two videos and one inference call.

**Architecture:** Version `photo_mode=gallery` selects a new photo-only appendix and validator. Historical single-photo requests/results remain unchanged. Portrait ranks the best available co-visible frame, with no face/composition gate; only evidence-backed absence is allowed. Ugly-cute supplies4–6 independently evidenced picks, actual-count/shortfall metadata and original-size gallery export in one decode pass. Existing eating/story prompts stay exact.

**Tech Stack:** Existing Python/FastAPI, FFmpeg/Pillow, vanilla JS, pytest/node:test and local browser QA.

---

The user explicitly corrected the previous strict-face assumption and requested implementation. Do not ask again whether hands count. Prefer additive versioning over rewriting historical results. Avoid consecutive near-identical images; preserve source evidence instead of inventing frames to meet count.

## Tasks

1. Create `tests/test_photo_gallery.py` first; run red. Implement `mukbang/photo_gallery.py` and new prompt appendix; minimally extend `photos.py` to accept partial-human portrait validation and trusted gallery export names. Test human hands/legs, absence contradictions,4–6 items, duplicate source frames, shortfall and old-mode invariance.
2. Add optional mode to `server.py`, choose appendix in `vision.py`, validate in `pipeline.py`, export/count gallery in `daily_outputs.py` and handle offline recovery. Test one inference, original videos retained and full-resolution batch images.
3. Adapt existing photo card into grouped gallery (portrait first, ugly-cute grid) in `daily.js/css/html`. Preserve old cards, safe URLs/plain text, original-aspect photos and per-image downloads/evidence. Test actual counts, failure/shortfall and one upload.
4. Load new code on an isolated preview if an existing service cannot be safely restarted. Re-run user source once, keep accepted old tasks, inspect portrait plus all gallery photos, verify mobile/desktop playback/downloads, run regression suites. Update docs and push only code/prompts/docs, never user media or secrets.

## Acceptance

- [x] Visible hand/leg/body with cat qualifies; no false not_found due to face crop.
- [x] Real demo has1 portrait and5 distinct ugly-cute photos, with auditable source times.
- [x] One inference, same two video categories, native-resolution photos, honest shortfall handling and history.
- [x] Automated and browser/media verification; Git archive excludes private artifacts.
