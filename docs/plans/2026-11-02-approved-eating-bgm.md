# Approved Eating BGM Implementation Plan

**Goal:** Use the four user-approved audition tracks for randomized local eating-video generation and save reproducible configuration to GitHub.

**Architecture:** Reuse the existing eating-only random selection and per-job pin. Install verified content-addressed audio beside the prior library, replacing only its manifest after validation. Preserve story music, existing jobs, original video and credential handling. Local-preview rights must never be presented as CC BY or commercial permission.

**Tech Stack:** Python, FFmpeg, FastAPI, existing vanilla JS UI, pytest.

## Design decision

Keeping only the audition page would not meet the requested automation. Replacing the shared story library would change unrelated behavior. Therefore update only the eating pool, with four equally eligible tracks and no extra AI/network requests during generation. Match approved audition mixing: -28 LUFS, -9 dBTP music limit, 0.4/1.2 second fades, original audio retained. Repeat short music only when the requested video is longer than the asset.

## Task 1 — contract and regression tests

- Add `services/mukbang-studio/tests/test_approved_eating_music.py` for four-track selection, retry pinning, local-only rights, path/hash validation, M4A responses and story isolation.
- Run pytest on that file before implementation (expected failures), then after (expected pass).

## Task 2 — library and mix integration

- Modify `mukbang/story_music_library.py` to accept explicitly marked local-preview eating assets without weakening the story CC-BY default; pin the mix preset with the selected track.
- Modify `mukbang/eating_music.py` to load the new preset and report truthful rights notices.
- Modify `mukbang/story_music.py` with an opt-in two-pass loudness preset matching auditions. Keep legacy RMS normalization unchanged.
- Update `server.py`, `web/eating-music.html`, `web/music.js`, `web/daily.js` for M4A and accurate notices.

## Task 3 — reproducible installation

- Add `docs/approved-eating-four-v1.json` containing approved IDs, hashes, filenames, durations and unconfirmed commercial-rights status, not audio or signed URLs.
- Add `scripts/install_approved_eating_music.py`: require explicit local-preview mode, verify all four hashes/audio, preserve old assets and manifest backup, atomically activate the new manifest.
- Keep media/data ignored by Git. Update root and service READMEs.

## Task 4 — verify and activate

- Run new and existing library/mix/pipeline tests, then the full suite.
- Install locally and invoke the real eating mixer on the approved 40-second original; verify pinned retries, unchanged video stream, duration and decoding.
- Check for active jobs before restarting only port 8883. Verify live API returns exactly the four new tracks and story configuration is unchanged.
- Commit only task files, push `feature/daily-dual-videos`, and verify remote commit. No force push, no API secrets or music binaries.
