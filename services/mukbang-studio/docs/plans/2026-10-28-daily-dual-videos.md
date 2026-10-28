# Daily Dual Videos Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The available executing-plans guidance is applied in this session; unavailable superpowers skills are not assumed installed.

**Goal:** One uploaded video and one existing multi-image vision request produce independent original-sound eating highlights and a factual human–pet interaction story, presented in a working phone-style web page.

**Architecture:** Keep the legacy eating system prompt, published P0004 taste prompt, sampling and rendering policy unchanged. The optional `story_enabled` mode appends an independent output contract to the same request; deterministic validation, original-PTS mapping and product-specific rendering follow without further vision calls. Add `/daily` while preserving `/` as the existing debugging tool and use a separate test deployment to avoid overwriting the unrelated distortion experiment.

**Tech Stack:** Existing Python/FastAPI, HTTPX single-request Responses transport, FFmpeg/FFprobe, Pillow, plain HTML/CSS/JavaScript, pytest and node:test.

---

## Scope and decisions

- First stage delivers two video categories only. Human–pet portraits and funny/ugly-cute photos are visibly marked unavailable, with no fabricated pictures or counts.
- A clearly visible human hand/body counts as human presence, matching the supplied UI reference. Both human and pet must be visible in the selected interval and perform an observable action–response; mere co-presence is insufficient.
- Story material must describe one coherent episode in source order. Every selected interval must explicitly account for all supplied in-interval sampled frames as jointly visible; event evidence is separate from eating-selected frames. This is sampled visual evidence, not a frame-perfect guarantee about unsampled instants.
- Story target defaults to 30 seconds, is aspirational, and has a 60-second hard cap. Do not stretch, repeat or add unrelated shots to meet it.
- Reuse the accepted natural-monologue process only for fact/event separation, natural titles and action/reaction rhythm. This stage does not silently add Qwen, speech synthesis, subtitles or BGM. Both videos use source sound.
- Product absence, invalid model structure and local rendering failure are different states. A missing story never becomes a fabricated success and must not erase valid eating output. Conversely, a story-only source may produce a valid story without inventing an eating video.
- Exact prompts, original model JSON, timelines, source/output timing maps and separate processing timings remain inspectable. Provider credentials and private media stay out of Git.

## Task 1: Optional same-request story schema and deterministic validation

**Files:** Modify `mukbang/vision.py`; create `mukbang/story.py`, `tests/test_story.py`, `tests/test_vision_dual.py`.

1. Write failing tests for explicit no-story, valid visible action/reaction, invalid/unknown IDs, half-open endpoints, nonfinite values, reverse/overlapping clips and events, disconnected declared episodes and missing human/pet presence.
2. Run `E:/AI/bobbo-mukbang-studio/.venv/Scripts/python.exe -m pytest tests/test_story.py tests/test_vision_dual.py -q` and confirm new functionality fails before implementation.
3. Implement `validate_story(parsed_story, frames, duration, options)` and append the optional independent `interaction_story` contract in `build_prompts` without editing the existing eating prompt or making new HTTP requests.
4. Run the new tests plus `tests/test_vision.py tests/test_relay_vision.py`; legacy prompts/payloads must remain compatible and new-mode transport still makes exactly one POST.

## Task 2: Independent video artifacts and original-PTS story mapping

**Files:** Modify `mukbang/pipeline.py`, `mukbang/timing.py`; create `mukbang/daily_outputs.py`, `tests/test_dual_pipeline.py`, `tests/test_daily_outputs.py`.

1. Write failing tests for two videos from one response, absent/invalid story preserving eating, story-only material, product render failures, cancellation, unchanged legacy outputs and separate rendering timings.
2. Run the new focused tests and confirm failures.
3. Validate story independently, quantize only inside the approved jointly visible source intervals, retain original event evidence and map each event to concatenated output time. Render using existing original-speed/audio/size checks.
4. Persist story decisions/timeline and technical validation separately; return `result.story`, `result.highlight_status` and real poster URLs in dual mode, while leaving legacy result shape intact.
5. Run pipeline, recovery, media and timing tests. Offline fixtures must never call a live provider.

## Task 3: Safe additive routes and job options

**Files:** Modify `mukbang/server.py`; create `tests/test_daily_server.py`.

1. Add failing tests for `/daily`, strict optional story flag/target, active published prompt inheritance, one job invocation and legacy defaults/options compatibility.
2. Add optional `story_enabled` and `story_target_duration`, `/daily` HTML route and additive feature metadata. Continue serving all artifacts through the existing safe file route.
3. Run the new tests and legacy server/revision/prompt tests against isolated temporary data only.

## Task 4: Phone-style functional page

**Files:** Create `web/daily.html`, `web/daily.css`, `web/daily.js`, `scripts/test_daily_frontend.cjs`.

1. Use the provided warm ivory/white rounded-card reference. Display real generated story/eating posters, metadata and source-sound video playback; no sample-image results or made-up durations.
2. Implement upload, editable targets, one submit, polling, cancellation, history, explicit per-product empty/error states and link back to the existing debugger.
3. Render model text with safe text nodes, restrict artifact URLs to same-origin job paths, keep mobile controls accessible, preserve original aspect ratio when playing, and handle legacy history without claiming a story was extracted.
4. Run `node scripts/test_daily_frontend.cjs` and existing `node scripts/test_frontend.cjs`; verify upload, progress, absent story, actual playback and responsive page in browser.

## Task 5: Regression, isolated deployment and source archive

**Files:** Update `services/mukbang-studio/README.md`, `docs/api-contract.md`, add `docs/daily-dual-videos.md` and root `README.md` in this isolated worktree only.

1. Run the full pytest suite and both frontend checks. Any synthetic/provider-mocked test is labeled as such, not a successful real AI run.
2. Deploy the new worktree on a free separate loopback port with its own data directory and a protected copy of the current published prompt library. Reuse the configured provider in memory; never export secrets to public files or modify the running 8876 service.
3. Perform a real user-scoped video run once, if the provider is available, using one request and no hidden retry. Check actual media metadata/playback and inspect only the already-generated input sheets if visually reviewing model choices.
4. Document the true validation boundary: one-frame-per-second sampling can miss brief actions; model co-visibility declarations are evidence, not an independent detector; one coherent episode is not a proven general-purpose animal-understanding benchmark.
5. Review staged files for unrelated changes, secrets and private artifacts; commit only this feature and publish to the user-authorized repository without force. Preserve the original dirty distortion worktree untouched.

## Acceptance checklist

- [x] Existing default eating path and current prompt are unchanged.
- [x] New mode shares one set of input sheets and exactly one vision POST.
- [x] Two independent validated video results, or honest absent/failed category states.
- [x] Source and output event times match real PTS and native-speed concatenation.
- [x] Human and pet are explicitly jointly visible in supplied samples with observable action and response; unsampled instants are not independently verified.
- [x] Phone UI upload, progress, history, playback and debug access work.
- [x] No fake photos, statistics, music, narration or additional visual API calls. Developer review used one existing input sheet, not a new model request.
- [x] Tests, actual deployment address and live-provider limitations are recorded in [the validation report](../daily-dual-validation-2026-10-28.md).
