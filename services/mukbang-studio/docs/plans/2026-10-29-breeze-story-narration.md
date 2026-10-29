# Breeze Story Narration Implementation Plan

> Execute locally in the existing isolated worktree; no additional agents. The referenced superpowers execution skill is unavailable; use Code guidance and pytest directly.

**Goal:** Use the user's approved private girl-baby voice for paid API narration, retaining one story, source sound, subtitles and no BGM.

**Architecture:** Opt-in server-side Breeze adapter sends only caption text to the fixed official HTTPS endpoint. Check commercial entitlement before synthesis, synthesize short lines with bounded concurrency/deadlines and no automatic POST retries, cache validated paid results, map real audio durations without cutting speech. Existing source renderer burns adjusted captions; a separate audio-only mix copies the encoded video. Failures preserve the subtitle-only story and expose a narration warning.

**Tech Stack:** Existing Python/httpx/pytest, FFmpeg; no extra dependencies or visual AI calls.

## Task 1: API adapter and timing

Create `mukbang/narration.py`, `tests/test_narration.py`. Test fixed host, entitlement, plain text, credential redaction, complete WAV validation, failed/truncated replies, duration scheduling and cache identity. Then implement. Key stays outside repository; tracked settings contain placeholders only. Run `python -m pytest tests/test_narration.py`.

## Task 2: Media and pipeline integration

Modify `mukbang/daily_outputs.py`, `mukbang/timing.py`, `mukbang/config.py`. Synthesis and mixing have separate measured stages. Never extend an approved interaction interval, change source speed, add a third product, or overwrite the clean source. Failure falls back explicitly, not silently. Add regressions for enabled success, disabled compatibility, failed narration and cancellation. Run existing dual/story/timing tests plus new tests.

## Task 3: Reusable existing-story entrypoint

Create `scripts/narrate_story.py`. Read the existing validated clip/caption timeline, create a new output directory, synthesize and render without repeating vision. Persist paid entitlement, per-line API timing, aligned subtitles, mixed-video verification and independent total wall time. Preserve original job/AI results and original generation timing. CLI only publishes when explicitly requested and exact service is idle/stopped, with backups.

## Task 4: Enable, verify and hand off

Add opt-in settings to `.env.example`, usage docs and README. Enable only the local 8883 service via its launcher environment, not all other instances. Run offline regressions, generate an independent sample with the actual API, fully decode final audio/video, inspect page playback and publish the prepared artifact with a recoverable backup. Restart only the verified idle 8883 process if needed. No payment operations; no free preview audio in the commercial sample. Report actual times and any audio-quality limits honestly.
