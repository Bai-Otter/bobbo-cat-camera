# Codex Client Label Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test whether two public Codex client labels resolve the current relay's explicit client restriction, without changing credentials, inference inputs or the one-request budget.

**Architecture:** A default-off server-only environment switch applies only to the initially imported Codex Responses provider. A shared fixed-label helper supplies both actual request headers and the nonsecret audit manifest. No alternate endpoint, signature, session, account header or retry is introduced.

**Tech Stack:** Python 3.12, HTTPX, pytest MockTransport, existing FastAPI service.

---

## Evidence and scope

- Failed Responses requests returned HTTP 403 with `This account only allows Codex official clients`. This is not evidence of an expired key.
- Installed CLI package metadata identifies version 0.156.1; its binary contains the public `originator` / `codex_cli_rs` labels. The minimal candidate is `User-Agent: codex_cli_rs/0.156.1` and `originator: codex_cli_rs`, without guessed OS suffixes.
- These labels are not authentication and are not an official promise of relay acceptance. The fetched official noninteractive documentation describes `codex exec`, not this relay's header policy: https://learn.chatgpt.com/docs/non-interactive-mode.md.
- The user explicitly selected header compatibility, not a change to CLI execution. The existing model remains `gpt-6.1-sol`.

### Task 1: Configuration boundaries (TDD)

**Files:**
- Modify: `mukbang/config.py`
- Test: `tests/test_codex_config.py`

1. Add failing tests for default-off, explicit opt-in, local `.env` precedence, HTTPS import, manual-provider exclusion, source changes, no-op saves, and immutable fake credentials/config.
2. Run `.venv/Scripts/python.exe -m pytest tests/test_codex_config.py -q` and verify the new contracts fail before implementation.
3. Allow `MUKBANG_VISION_CODEX_CLIENT_COMPAT` in the local environment parser. Bind the switch to the imported complete `(base_url, model, api_style)` and configuration source. Require Responses. Actual manual changes disable compatibility for this instance, even if later reverted.
4. Expose `provider.client_compatibility` as `none` or `codex_cli_rs/0.156.1`. Pass only a derived private `codex_client_compat` boolean to the transport. Do not add browser-writable fields.
5. Re-run the configuration tests; all must pass without live credentials/network.

### Task 2: Fixed headers and audit (TDD)

**Files:**
- Modify: `mukbang/vision.py`
- Test: `tests/test_relay_vision.py`

1. Add failing offline tests for exact two-header opt-in, strict boolean checks, Responses only, unchanged payload bytes/authorization, manifest redaction and single-POST refusal handling.
2. Run `.venv/Scripts/python.exe -m pytest tests/test_relay_vision.py -q` and confirm the intended failures.
3. Implement `client_identity_headers(model_config)` using fixed public values only. Call it from `request_manifest` (`client_headers`) and `call_vision`.
4. Explain the known HTTP 403 client restriction explicitly; preserve redacted raw evidence. Do not mutate the body or add retries/fallbacks.
5. Re-run both targeted files and the full Python and frontend suites.

### Task 3: Documentation, deployment and one live verification

**Files:**
- Modify: `.env.example`, `README.md`, `docs/api-contract.md`
- Local runtime only: the existing live service `.env` (no credentials copied).

1. Document opt-in, scope, audit fields, limitations, and disabling via `MUKBANG_VISION_CODEX_CLIENT_COMPAT=0` plus restart. Do not imply a client label grants permission.
2. Before deployment, compare live/repository files and verify jobs/proposals are idle. Back up only the exact runtime files being replaced. Preserve historical jobs, timings and the prompt library.
3. Deploy code; enable the explicit local switch. Revalidate the listening PID/command and restart the known idle process with a hidden window.
4. Perform at most one new video-generation request, keeping the original failed task intact. Count real model POSTs and retain the manifest, raw response and timings; no follow-up probe if refused.
5. If refused, disable the local switch and report the exact result. If accepted, verify local rendering and the unchanged active prompt. Commit/push only public source, tests and docs; never include private media/config.

## Acceptance

- Other providers/default installations never inherit these Codex labels.
- Model, prompt, image payload, original key, absolute deadline and zero-retry behavior are unchanged.
- The manifest matches the two actually sent nonsecret labels and never exposes credentials.
- A real refusal remains a refusal, not fabricated output or a hidden second call.

## Execution outcome

Implemented and independently reviewed. The one live attempt (`dd44f0f9bfa3`) returned the same explicit official-client-only HTTP 403; no retry was made. The local compatibility switch was restored to `0`, preserving P0004 / revision 3 and historical records. The feature remains default-off with a clear failure explanation, not represented as a successful connection fix. See `docs/client-compatibility-2026-10-23.md` for evidence and verification.
