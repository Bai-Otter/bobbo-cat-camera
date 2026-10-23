"""Offline Codex-relay transport fixtures: no real credential/network/image."""
import asyncio
import hashlib
import json
import time

import httpx
import pytest

from mukbang import vision


def config(**changes):
    return {"model": "gpt-6.1-sol", "api_style": "responses", "base_url": "http://relay.example/v1",
            "trusted_http_base_url": "http://relay.example/v1", "stream": True, "store": False,
            "api_key": "OFFLINE_FIXTURE_SECRET", **changes}


def sheets(tmp_path, count=3):
    result = []
    for i in range(count):
        path = tmp_path / f"fixture-{i}.jpg"
        content = f"offline synthetic byte fixture {i}".encode()
        path.write_bytes(content)
        result.append({"id": f"S{i + 1:02d}", "path": path.name, "width": 20, "height": 20,
                       "sha256": hashlib.sha256(content).hexdigest()})
    return result


def event(kind, **body):
    return "event: " + kind + "\ndata: " + json.dumps({"type": kind, **body}, ensure_ascii=False) + "\n\n"


def completed(text='{"ok":true}', **extra):
    envelope = {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
                "usage": {"input_tokens": 10, "output_tokens": 4}, **extra}
    return event("response.completed", response=envelope)


def install_transport(monkeypatch, handler):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(vision.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))


def test_trusted_http_is_exact_base_only():
    assert vision.endpoint_url("HTTP://RELAY.EXAMPLE/v1/", "responses", trusted_http_base_url="http://relay.example/v1") == "http://relay.example/v1/responses"
    for base in ("http://relay.example/v2", "http://other.example/v1", "http://relay.example:80/v1", "http://relay.example/v1-extra"):
        with pytest.raises(vision.VisionError, match="HTTPS"):
            vision.endpoint_url(base, "responses", trusted_http_base_url="http://relay.example/v1")
    with pytest.raises(vision.VisionError, match="HTTPS"):
        vision.endpoint_url("http://relay.example/v1", "responses")


def test_exact_model_and_three_images_one_sse_post(tmp_path, monkeypatch):
    calls = []
    raw = event("response.output_text.delta", delta='{"ignored":"delta"}') + completed()
    def handler(request):
        calls.append(request)
        body = json.loads(request.content)
        assert body["model"] == "gpt-6.1-sol"
        assert body["stream"] is True and body["store"] is False
        assert body["instructions"] == "SYSTEM fixture"
        assert sum(x["type"] == "input_image" for x in body["input"][0]["content"]) == 3
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=raw)
    install_transport(monkeypatch, handler)
    prompt = {"system": "SYSTEM fixture", "user": "USER fixture"}
    image_list = sheets(tmp_path)
    result = vision.call_vision(prompt, image_list, tmp_path, config())
    assert len(calls) == 1
    assert result["text"] == '{"ok":true}'
    assert result["usage"]["output_tokens"] == 4
    assert result["envelope"]["_transport"] == "sse"
    manifest = json.dumps(vision.request_manifest(prompt, image_list, config()))
    assert "trusted_http_base_url" not in manifest and "OFFLINE_FIXTURE_SECRET" not in manifest and "base64," not in manifest


def test_completed_envelope_wins_without_double_appending():
    raw = event("response.output_text.delta", delta='{"ok":') + event("response.output_text.delta", delta="true}") + completed()
    result = vision.parse_response_sse(raw)
    assert vision.extract_text(result, "responses") == '{"ok":true}'


def test_crlf_comment_multiline_and_delta_fallback():
    raw = ": heartbeat\r\n\r\n" + event("response.output_text.delta", delta='{"猫":').replace("\n", "\r\n")
    raw += 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"\\\"可爱\\\"}"}\r\n\r\n'
    raw += event("response.completed", response={"status": "completed", "output": [], "usage": {"output_tokens": 3}})
    raw += "data: [DONE]\n\n"
    result = vision.parse_response_sse(raw)
    assert json.loads(vision.extract_text(result, "responses")) == {"猫": "可爱"}


def test_done_text_overrides_partial_delta():
    raw = event("response.output_text.delta", delta="partial") + event("response.output_text.done", text='{"ok":true}')
    raw += event("response.completed", response={"status": "completed", "output": []})
    assert vision.extract_text(vision.parse_response_sse(raw), "responses") == '{"ok":true}'


@pytest.mark.parametrize("raw", [
    event("response.output_text.delta", delta='{"ok":true}'),
    'data: [DONE]\n\n',
    event("response.failed", response={"status": "failed"}),
    event("response.incomplete", response={"status": "incomplete"}),
    event("error", message="offline fixture error"),
    event("response.completed", response={"status": "incomplete", "output_text": "{}"}),
])
def test_no_success_without_completed_valid_terminal(raw):
    with pytest.raises(vision.VisionError) as failure:
        vision.parse_response_sse(raw)
    assert failure.value.raw_text == raw


def test_failed_sse_is_redacted_and_never_retried(tmp_path, monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=event("error", message="OFFLINE_FIXTURE_SECRET"))
    install_transport(monkeypatch, handler)
    with pytest.raises(vision.VisionError) as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path, config())
    assert len(calls) == 1
    assert "OFFLINE_FIXTURE_SECRET" not in failure.value.raw_text
    assert "[REDACTED]" in failure.value.raw_text


@pytest.mark.parametrize("status", ["failed", "incomplete"])
def test_nonstream_json_failed_status_is_not_success(tmp_path, monkeypatch, status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"status": status, "output_text": '{"ok":true}'})
    install_transport(monkeypatch, handler)
    with pytest.raises(vision.VisionError, match="未完成"):
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path, config(stream=False))
    assert len(calls) == 1


def test_sse_success_with_unicode_split_across_bytes(tmp_path, monkeypatch):
    raw = completed('{"猫":"可爱"}').encode("utf-8")
    class Split(httpx.AsyncByteStream):
        async def __aiter__(self):
            for i in range(0, len(raw), 7):
                yield raw[i:i + 7]
    install_transport(monkeypatch, lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Split()))
    result = vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path, config())
    assert json.loads(result["text"]) == {"猫": "可爱"}


def test_sse_byte_limit_and_no_retry(tmp_path, monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b":" + b"x" * 2_000_001)
    install_transport(monkeypatch, handler)
    with pytest.raises(vision.VisionError, match="过大") as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path, config())
    assert len(calls) == 1
    assert len(failure.value.raw_text.encode()) <= 2_000_000


def test_sse_total_timeout_preserves_partial_raw(tmp_path, monkeypatch):
    clock = [0.0]
    calls = []
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b": already received\n\n"
            clock[0] = 901.0
            yield b": late heartbeat\n\n"
    def handler(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Slow())
    install_transport(monkeypatch, handler)
    monkeypatch.setattr(vision.time, "monotonic", lambda: clock[0])
    with pytest.raises(vision.VisionError, match="总时限") as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path, config(timeout_seconds=900))
    assert len(calls) == 1
    assert "already received" in failure.value.raw_text
    assert "900" in str(failure.value)


def test_sse_can_finish_after_old_240_second_limit(tmp_path, monkeypatch):
    clock, calls = [0.0], []
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield event("response.output_text.delta", delta='{"ok":').encode()
            clock[0] = 300.0
            yield completed().encode()
    def handler(request):
        calls.append(request)
        assert request.extensions["timeout"]["read"] == 600
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Slow())
    install_transport(monkeypatch, handler)
    monkeypatch.setattr(vision.time, "monotonic", lambda: clock[0])
    result = vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                                config(timeout_seconds=600))
    assert result["text"] == '{"ok":true}'
    assert result["elapsed_seconds"] == 300
    assert len(calls) == 1


@pytest.mark.parametrize("seconds", [0, 29.9, 1801, float("nan"), float("inf"), True, "invalid", None])
def test_invalid_direct_transport_timeout_never_sends_request(tmp_path, monkeypatch, seconds):
    def forbidden(**kwargs):
        raise AssertionError("invalid timeout must fail before creating a client")
    monkeypatch.setattr(vision.httpx, "AsyncClient", forbidden)
    with pytest.raises(vision.VisionError, match="30.*1800"):
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                           config(timeout_seconds=seconds))


def test_request_manifest_records_effective_timeout_without_secret(tmp_path):
    manifest = vision.request_manifest({"system": "s", "user": "u"}, sheets(tmp_path),
                                      config(timeout_seconds=900))
    assert manifest["timeout_seconds"] == 900
    assert "OFFLINE_FIXTURE_SECRET" not in json.dumps(manifest)


@pytest.mark.parametrize("style, streaming", [
    ("responses", True), ("responses", False), ("chat_completions", False),
])
@pytest.mark.parametrize("mode", ["continuous_drip", "blocked_read"])
def test_absolute_deadline_cancels_and_closes_all_wire_formats(tmp_path, monkeypatch, style, streaming, mode):
    """A short internal deadline proves cancellation without a 30-second test."""
    state = {"calls": 0, "cancelled": False, "closed": False, "client_closed": False}
    real_timeout = asyncio.timeout
    real_client = httpx.AsyncClient
    def short_timeout(seconds):
        assert 0 < seconds <= 30  # The public setting still passed normal validation.
        return real_timeout(0.075)
    monkeypatch.setattr(asyncio, "timeout", short_timeout)
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b': received OFFLINE_FIXTURE_SECRET\n\n' if streaming else b'{"received":"OFFLINE_FIXTURE_SECRET",'
            try:
                if mode == "blocked_read":
                    await asyncio.sleep(60)
                else:
                    while True:
                        await asyncio.sleep(0.01)
                        yield b" "
            except asyncio.CancelledError:
                state["cancelled"] = True
                raise
        async def aclose(self):
            state["closed"] = True
    async def handler(request):
        state["calls"] += 1
        assert request.method == "POST"
        content_type = "text/event-stream" if streaming else "application/json"
        return httpx.Response(200, headers={"content-type": content_type}, stream=Slow())
    class Transport(httpx.MockTransport):
        async def aclose(self):
            state["client_closed"] = True
            await super().aclose()
    monkeypatch.setattr(vision.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=Transport(handler), **kwargs))
    def forbid_sync_client(**kwargs):
        raise AssertionError("a per-read sync client cannot enforce the absolute deadline")
    monkeypatch.setattr(vision.httpx, "Client", forbid_sync_client)
    started = time.perf_counter()
    with pytest.raises(vision.VisionError, match="总时限") as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                           config(api_style=style, stream=streaming, timeout_seconds=30))
    elapsed = time.perf_counter() - started
    assert 0.04 <= elapsed < 2.0
    assert state == {"calls": 1, "cancelled": True, "closed": True, "client_closed": True}
    assert "received" in failure.value.raw_text and "[REDACTED]" in failure.value.raw_text
    assert "OFFLINE_FIXTURE_SECRET" not in failure.value.raw_text


def test_absolute_deadline_also_cancels_waiting_for_response_headers(tmp_path, monkeypatch):
    state = {"calls": 0, "cancelled": False, "client_closed": False}
    real_timeout, real_client = asyncio.timeout, httpx.AsyncClient
    monkeypatch.setattr(asyncio, "timeout", lambda _seconds: real_timeout(0.05))
    async def handler(request):
        state["calls"] += 1
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        raise AssertionError("unreachable")
    class Transport(httpx.MockTransport):
        async def aclose(self):
            state["client_closed"] = True
            await super().aclose()
    monkeypatch.setattr(vision.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=Transport(handler), **kwargs))
    monkeypatch.setattr(vision.httpx, "Client", lambda **kwargs: pytest.fail("must use cancellable async transport"))
    with pytest.raises(vision.VisionError, match="总时限") as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                           config(timeout_seconds=30))
    assert state == {"calls": 1, "cancelled": True, "client_closed": True}
    assert failure.value.raw_text == ""


@pytest.mark.parametrize("style, streaming", [
    ("responses", True), ("responses", False), ("chat_completions", False),
])
def test_incremental_json_success_is_unchanged_for_all_wire_formats(tmp_path, monkeypatch, style, streaming):
    calls = []
    text = '{"猫":"可爱"}'
    envelope = ({"status": "completed", "output_text": text} if style == "responses" else
                {"choices": [{"message": {"content": text}}]})
    raw = json.dumps(envelope, ensure_ascii=False).encode()
    class Split(httpx.AsyncByteStream):
        async def __aiter__(self):
            for i in range(0, len(raw), 7):
                yield raw[i:i + 7]
    def handler(request):
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "application/json"}, stream=Split())
    install_transport(monkeypatch, handler)
    result = vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                                config(api_style=style, stream=streaming))
    assert len(calls) == 1
    assert result["text"] == text
    assert result["envelope"] == envelope


@pytest.mark.parametrize("style, streaming", [
    ("responses", True), ("responses", False), ("chat_completions", False),
])
def test_network_read_timeout_retains_partial_and_closes_without_retry(tmp_path, monkeypatch, style, streaming):
    state = {"calls": 0, "closed": False}
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'received OFFLINE_FIXTURE_SECRET'
            raise httpx.ReadTimeout("private transport error OFFLINE_FIXTURE_SECRET")
        async def aclose(self):
            state["closed"] = True
    def handler(request):
        state["calls"] += 1
        return httpx.Response(200, stream=Broken())
    install_transport(monkeypatch, handler)
    with pytest.raises(vision.VisionError, match="超时") as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                           config(api_style=style, stream=streaming))
    assert state == {"calls": 1, "closed": True}
    assert "received [REDACTED]" == failure.value.raw_text
    assert "OFFLINE_FIXTURE_SECRET" not in str(failure.value)


@pytest.mark.parametrize("changes, expected", [
    ({"codex_client_compat": True}, {"User-Agent": "codex_cli_rs/0.156.1", "originator": "codex_cli_rs"}),
    ({}, {}),
    ({"codex_client_compat": False}, {}),
    ({"codex_client_compat": "true"}, {}),
    ({"codex_client_compat": 1}, {}),
    ({"codex_client_compat": True, "api_style": "chat_completions"}, {}),
])
def test_client_identity_headers_are_strict_opt_in_for_responses_only(changes, expected):
    provider = config(**changes)
    original = provider.copy()
    assert vision.client_identity_headers(provider) == expected
    assert provider == original
    assert "OFFLINE_FIXTURE_SECRET" not in json.dumps(expected)


@pytest.mark.parametrize("changes, expected", [
    ({"codex_client_compat": True}, {"User-Agent": "codex_cli_rs/0.156.1", "originator": "codex_cli_rs"}),
    ({}, {}),
    ({"codex_client_compat": False}, {}),
    ({"codex_client_compat": "true"}, {}),
    ({"codex_client_compat": 1}, {}),
    ({"codex_client_compat": True, "api_style": "chat_completions"}, {}),
])
def test_client_compat_manifest_matches_actual_identity_without_changing_payload(tmp_path, monkeypatch, changes, expected):
    calls = []
    prompts = {"system": "exact system fixture", "user": "exact user fixture 猫"}
    image_list = sheets(tmp_path)
    provider = config(**changes)
    baseline = vision.make_payload(prompts, image_list, tmp_path, {**provider, "codex_client_compat": False})
    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        assert request.headers["authorization"] == "Bearer OFFLINE_FIXTURE_SECRET"
        assert json.loads(request.content) == baseline
        if expected:
            assert request.headers["user-agent"] == expected["User-Agent"]
            assert request.headers["originator"] == expected["originator"]
        else:
            assert "originator" not in request.headers
            assert not request.headers.get("user-agent", "").startswith("codex_cli_rs/")
        if provider["api_style"] == "responses":
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=completed())
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok":true}'}}]})
    install_transport(monkeypatch, handler)
    result = vision.call_vision(prompts, image_list, tmp_path, provider)
    assert len(calls) == 1 and result["text"] == '{"ok":true}'
    manifest = vision.request_manifest(prompts, image_list, provider)
    assert manifest["client_headers"] == expected
    assert manifest["image_count"] == 3 and manifest["automatic_retries"] == 0
    assert manifest["system"] == prompts["system"] and manifest["user"] == prompts["user"]
    assert manifest["model"] == "gpt-6.1-sol"
    assert all(key.lower() != "authorization" for key in manifest["client_headers"])
    assert "OFFLINE_FIXTURE_SECRET" not in json.dumps(manifest)


@pytest.mark.parametrize("streaming", [True, False])
def test_client_compat_toggle_changes_only_headers_not_request_body_bytes(tmp_path, monkeypatch, streaming):
    calls = []
    prompts = {"system": "same system 猫", "user": "same prompt and target parameters"}
    image_list = sheets(tmp_path)
    def handler(request):
        calls.append(request)
        if streaming:
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=completed())
        return httpx.Response(200, json={"status": "completed", "output_text": '{"ok":true}'})
    install_transport(monkeypatch, handler)
    for enabled in (False, True):
        before_count = len(calls)
        vision.call_vision(prompts, image_list, tmp_path, config(stream=streaming, codex_client_compat=enabled))
        assert len(calls) == before_count + 1  # Exactly one POST per explicit operation.
    assert calls[0].content == calls[1].content
    assert calls[0].url == calls[1].url
    assert calls[0].headers["authorization"] == calls[1].headers["authorization"]
    assert calls[0].headers["content-type"] == calls[1].headers["content-type"]
    assert "originator" not in calls[0].headers
    assert calls[1].headers["originator"] == "codex_cli_rs"
    assert calls[1].headers["user-agent"] == "codex_cli_rs/0.156.1"


@pytest.mark.parametrize("compat", [False, True])
def test_codex_official_client_403_explains_rejection_and_never_retries_with_other_headers(tmp_path, monkeypatch, compat):
    calls = []
    raw = json.dumps({"error": {"message": "This account only allows Codex official clients",
                                "type": "forbidden_error", "detail": "OFFLINE_FIXTURE_SECRET"}})
    raw += event("response.failed", response={"status": "failed", "output": [],
                                               "error": {"code": "upstream_error", "message": "Upstream request failed"}})
    def handler(request):
        calls.append(request)
        return httpx.Response(403, headers={"content-type": "text/event-stream"}, text=raw)
    install_transport(monkeypatch, handler)
    with pytest.raises(vision.VisionError) as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                           config(codex_client_compat=compat))
    assert len(calls) == 1
    assert "HTTP 403" in str(failure.value) and "客户端" in str(failure.value)
    assert "拒绝" in str(failure.value) or "仅允许" in str(failure.value)
    assert "This account only allows Codex official clients" in failure.value.raw_text
    assert failure.value.raw_text == raw.replace("OFFLINE_FIXTURE_SECRET", "[REDACTED]")
    assert "OFFLINE_FIXTURE_SECRET" not in str(failure.value)


def test_unrelated_403_keeps_generic_failure_and_single_post(tmp_path, monkeypatch):
    calls = []
    raw = '{"error":{"message":"Quota denied OFFLINE_FIXTURE_SECRET"}}'
    def handler(request):
        calls.append(request)
        return httpx.Response(403, text=raw)
    install_transport(monkeypatch, handler)
    with pytest.raises(vision.VisionError) as failure:
        vision.call_vision({"system": "s", "user": "u"}, sheets(tmp_path), tmp_path,
                           config(codex_client_compat=True))
    assert len(calls) == 1
    assert str(failure.value) == "视觉服务返回HTTP 403；未自动重试，请在原始返回中检查详情"
    assert failure.value.raw_text == raw.replace("OFFLINE_FIXTURE_SECRET", "[REDACTED]")
