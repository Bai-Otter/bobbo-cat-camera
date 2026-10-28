# Story Inner Monologue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use the available executing-plans workflow; no subagents or unavailable tools are assumed.

**Goal:** Upgrade the existing single story to a fuller source-sound video with sparse, cute first-person inner-monologue subtitles; retain the separate eating video unchanged.

**Architecture:** A versioned `story_mode=inner_monologue` appends a new independent story contract to the same vision request. It searches the whole upload for connected interaction beats in one shared routine, targets the requested duration ±5 seconds, and preserves the existing sampled human/pet co-visibility requirement. Local validators map factual events and clearly fictional captions to final source-PTS cuts, then burn ASS subtitles in the existing single encoding pass. Legacy history and requests remain unchanged.

**Tech Stack:** Existing Python/FastAPI, pytest, FFmpeg/libass, plain JavaScript and node:test.

---

User correction on October 29: two total video categories, not three; existing story becomes original sound + inner-monologue subtitles. No TTS, no BGM, no third video, no automatic AI retry. Use the previously approved natural-reaction writing principles, not the discarded dense/cutesy first script. Default mobile story target becomes35 seconds (working band30–40). Insufficient material is explicitly reported, never silently treated as meeting target or padded with duplicate shots. Human/pet co-visibility is retained, not silently relaxed.

## Task 1: Contract and validation

- Add `prompts/story-inner-monologue-system-appendix.txt`, select it in `mukbang/vision.py`; keep old prompt and P0004 byte-exact.
- Extend `mukbang/story.py` parameters and add `mukbang/story_subtitles.py`: factual narrative arc, full-source review declaration, shortfall reason when needed, anchored plain-text captions, readability/nonoverlap/leave-space checks.
- Add `tests/test_story_subtitles.py`; run it before implementation (expected missing module failure), then after (expected pass). Include a30-second three-beat fixture and historical-mode checks.

## Task 2: One rendered story, original sound plus subtitles

- Modify `mukbang/daily_outputs.py` to map captions through actual quantized cuts, save source/output timing and SRT/ASS, and expose subtitle metadata in the same existing story result.
- Extend `mukbang/media.py` with optional trusted local ASS in the existing filter graph, not a second encoding. Preserve default command generation, source PTS, dimensions, audio and range checks.
- Add real synthetic-media tests for caption presence, absence outside cue times, source audio, same frame counts and unsafe path rejection. Test new pipeline failure isolation and legacy recovery.

## Task 3: API, mobile page and recovery

- Add versioned story mode to `mukbang/server.py` without changing legacy request fingerprints; validate it during offline recovery.
- Update `web/daily.js`/`daily.html`: request upgraded mode by default, retain one story card, show target vs actual duration and inspectable subtitle cues; old records are labeled original-sound historical versions without invented subtitles.
- Update `scripts/test_daily_frontend.cjs` and server tests; run both frontend suites and the Python regression suite.

## Task 4: Real preview and archive

- Use independent8881 with `data/daily-inner-monologue/`; preserve existing8880/8876/8879 and unrelated dirty worktrees. Only restart our new preview after checking no live jobs.
- One fresh request on the user's latest120.9-second source verifies the changed prompt (one batch of sheets, no retry). Preserve the old10.8-second result and earlier11-second sample. Inspect resulting subtitles/timing locally, not repeated AI image requests.
- Record actual duration/captions/cost and remaining limitations; update README/method docs. Commit only feature files and push without force. Never publish media, model credentials or runtime data.

## Acceptance

- [x] Still one eating video and one story video.
- [x] Actual story targets30–40seconds for the35second demo when supported; honest shortfall otherwise.
- [x] Cute natural inner monologues with readable sparse subtitles, no generated voice or music.
- [x] One visual request, original eating prompts intact, old records unchanged.
- [x] Automated and real-media checks, private-artifact exclusion, Git archive.

Execution: 35-second/5-caption real demo, one visual request; 760 Python tests and86 frontend tests passed (2 Python skips). Local phone-font restyle reused exact decisions, cost63.298s with0 additional AI calls; prior artifacts backed up. Independent8881 preview and desktop/mobile read-only playback verified. See `../story-inner-monologue-2026-10-29.md` for method and limitations.
