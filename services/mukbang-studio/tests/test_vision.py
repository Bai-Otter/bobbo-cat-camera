import hashlib
import json

import httpx
import pytest

from mukbang import vision


def prompt_input():
    return ({"target_duration": 43, "min_duration": 32, "max_duration": 49, "prompt": "自定义测试"},
            {"duration": 180}, {"interval": 1, "frame_count": 180, "sheet_count": 3,
                                  "frames": [{"id": "F0001", "time": 0, "sheet_id": "S01", "row": 1, "col": 1}]})


def test_actual_duration_values_in_sent_prompt():
    prompts = vision.build_prompts(*prompt_input())
    assert '"target_duration_seconds": 43' in prompts["user"]
    assert '"min_duration_seconds": 32' in prompts["user"]
    assert '"max_duration_seconds": 49' in prompts["user"]
    assert '"sheets_in_this_single_request": 3' in prompts["user"]
    assert "自定义测试" in prompts["user"]


def _sheets(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"synthetic-placeholder-not-viewed")
    return [{"id": "S01", "path": "a.jpg", "width": 2, "height": 2,
             "sha256": hashlib.sha256((tmp_path / "a.jpg").read_bytes()).hexdigest()}]


@pytest.mark.parametrize("style", ["chat_completions", "responses"])
def test_all_images_in_one_request_and_no_key_in_manifest(tmp_path, style):
    sheets = _sheets(tmp_path) * 3
    config = {"model": "test-model", "api_style": style, "base_url": "https://example.com/v1", "api_key": "SECRET_TEST_KEY"}
    prompts = vision.build_prompts(*prompt_input())
    payload = vision.make_payload(prompts, sheets, tmp_path, config)
    encoded = json.dumps(payload)
    assert encoded.count("data:image/jpeg;base64,") == 3
    assert "SECRET_TEST_KEY" not in encoded
    manifest = json.dumps(vision.request_manifest(prompts, sheets, config))
    assert "SECRET_TEST_KEY" not in manifest and "base64," not in manifest and "Authorization" not in manifest


def test_http_failure_no_auto_retry_or_key_leak(tmp_path, monkeypatch):
    calls = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, *args, **kwargs):
            calls.append(args)
            return httpx.Response(429, text="SECRET_TEST_KEY quota exceeded")
    monkeypatch.setattr(vision.httpx, "Client", Client)
    config = {"model": "test", "api_style": "chat_completions", "base_url": "https://example.com/v1", "api_key": "SECRET_TEST_KEY"}
    with pytest.raises(vision.VisionError) as caught:
        vision.call_vision(vision.build_prompts(*prompt_input()), _sheets(tmp_path), tmp_path, config)
    assert len(calls) == 1
    assert "SECRET_TEST_KEY" not in caught.value.raw_text


@pytest.mark.parametrize("url", ["file:///a", "http://example.com/v1", "https://user:key@example.com", "https://example.com?api_key=123"])
def test_unsafe_provider_url_rejected(url):
    with pytest.raises(vision.VisionError):
        vision.endpoint_url(url, "chat_completions")


def test_json_parse_failure_is_visible():
    with pytest.raises(vision.VisionError):
        vision.parse_model_json("I think the cat is cute")
    with pytest.raises(vision.VisionError):
        vision.parse_model_json('{"value": NaN}')
    assert vision.parse_model_json('```json\n{"ok": true}\n```')["ok"]


def test_responses_envelope_text():
    assert vision.extract_text({"output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}]}, "responses") == "{}"
