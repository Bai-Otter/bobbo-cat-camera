import io
import wave

import httpx
import pytest

from mukbang.narration import BreezeConfig, NarrationError, align_cues, synthesize


def wav(seconds=1.5):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as f:
        f.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        f.writeframes(b"\x01\x00" * int(24000 * seconds))
    return stream.getvalue()


def config():
    return BreezeConfig(api_key="private-test-key", voice_id="test_voice")


def test_voice_and_secret_not_in_repr():
    assert "private-test-key" not in repr(config())


def test_align_duration_preserves_start_and_readability():
    cues = [{"id": "m1", "clip_id": "s1", "text": "你好呀", "output_start": 1., "output_end": 2.4, "source_end": 12.4}]
    mapped = align_cues(cues, [{"id": "s1", "output_end": 10}], [{"duration": 2.8}])
    assert mapped[0]["output_start"] == 1
    assert mapped[0]["output_end"] == pytest.approx(4.0)
    assert cues[0]["output_end"] == 2.4
    assert mapped[0]["source_end"] == pytest.approx(14.)
    assert mapped[0]["original_source_subtitle_end"] == 12.4


def test_no_cutoff_or_crossing_next_line():
    cues = [{"id": "m1", "clip_id": "s1", "text": "喵", "output_start": 1., "output_end": 2.4},
            {"id": "m2", "clip_id": "s1", "text": "嗯", "output_start": 4., "output_end": 5.4}]
    with pytest.raises(NarrationError, match="放不下"):
        align_cues(cues, [{"id": "s1", "output_end": 8}], [{"duration": 4}, {"duration": 1}])


def test_paid_synthesis_cache_and_contract(tmp_path):
    calls = []
    def handle(request):
        calls.append(request)
        assert request.url.host == "api.breeze.blue"
        if request.method == "GET":
            return httpx.Response(200, json={"commercial_use_allowed": True, "plan_code": "starter", "status": "active", "max_concurrent_generations": 4})
        import json
        body = json.loads(request.content)
        assert body["model_id"] == "breeze-tts-2" and body["language_code"] == "zh"
        assert body["voice_settings"]["speed"] == 1
        return httpx.Response(200, content=wav(), headers={"content-type": "audio/wav"})
    cue = [{"id": "m1", "text": "里面还有呀？"}]
    result = synthesize(config(), cue, tmp_path, transport=httpx.MockTransport(handle))
    assert result["clips"][0]["duration"] == 1.5
    assert result["clips"][0]["cache_hit"] is False
    second = synthesize(config(), cue, tmp_path, transport=httpx.MockTransport(handle))
    assert second["clips"][0]["cache_hit"] is True
    assert len([c for c in calls if c.method == "POST"]) == 1
    assert "private-test-key" not in str(result)


def test_free_account_cannot_generate_commercial_sample(tmp_path):
    def handle(request):
        assert request.method == "GET"
        return httpx.Response(200, json={"commercial_use_allowed": False, "plan_code": "free"})
    with pytest.raises(NarrationError, match="商用"):
        synthesize(config(), [{"id": "m1", "text": "喵"}], tmp_path, transport=httpx.MockTransport(handle))


@pytest.mark.parametrize("status,data", [(429, b"private-test-key"), (200, b"truncated wave")])
def test_error_redacted_no_retry(tmp_path, status, data):
    posts = []
    def handle(request):
        if request.method == "GET":
            return httpx.Response(200, json={"commercial_use_allowed": True})
        posts.append(request)
        return httpx.Response(status, content=data, headers={"content-type": "audio/wav"})
    with pytest.raises(NarrationError) as err:
        synthesize(config(), [{"id": "m1", "text": "喵"}], tmp_path, transport=httpx.MockTransport(handle))
    assert "private-test-key" not in str(err.value)
    assert len(posts) == 1


def test_corrupt_cache_not_reused(tmp_path):
    calls = []
    def handle(request):
        if request.method == "GET":
            return httpx.Response(200, json={"commercial_use_allowed": True})
        calls.append(request)
        return httpx.Response(200, content=wav(), headers={"content-type": "audio/wav"})
    cues = [{"id": "m1", "text": "喵"}]
    first = synthesize(config(), cues, tmp_path, transport=httpx.MockTransport(handle))
    (tmp_path / first["clips"][0]["file"]).write_bytes(b"invalid")
    second = synthesize(config(), cues, tmp_path, transport=httpx.MockTransport(handle))
    assert not second["clips"][0]["cache_hit"] and len(calls) == 2


def test_cancel_before_network(tmp_path):
    from mukbang.media import Cancelled
    def handle(request):
        pytest.fail("cancelled request must not reach network")
    with pytest.raises(Cancelled):
        synthesize(config(), [{"id":"m1","text":"喵"}], tmp_path, lambda: True, transport=httpx.MockTransport(handle))


def test_rejects_wrong_host_voice_path_and_invalid_text(tmp_path):
    with pytest.raises(NarrationError):
        BreezeConfig("key", "../../other")
    def handle(request):
        pytest.fail("invalid text must not reach network")
    with pytest.raises(ValueError):
        synthesize(config(), [{"id":"m1","text":"<script>"}], tmp_path, transport=httpx.MockTransport(handle))


def test_mix_complete_speech_with_source_audio(tmp_path):
    import shutil
    from mukbang import media
    from mukbang.narration import mix_video
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg unavailable")
    source = tmp_path / "source.mp4"
    media.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=160x90:rate=10:duration=3",
               "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=8000:duration=3", "-c:v", "libx264",
               "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)])
    (tmp_path/"voice.wav").write_bytes(wav())
    result = mix_video(source, tmp_path/"voiced.mp4", [{"output_start":.5}],
                       {"clips":[{"file":"voice.wav","duration":1.5}]}, tmp_path)
    assert result["narration_added"] and result["full_decode_pass"]
    assert result["audio_sample_rate"] == 48000
    assert result["actual_container_duration_seconds"] == pytest.approx(3, abs=.15)


def test_per_cue_performance_reaches_tts_and_changes_cache(tmp_path):
    import json
    posted=[]
    def handle(request):
        if request.method=='GET':
            return httpx.Response(200,json={'commercial_use_allowed':True})
        posted.append(json.loads(request.content))
        return httpx.Response(200,content=wav(),headers={'content-type':'audio/wav'})
    transport=httpx.MockTransport(handle)
    for direction in ('前半句疑问，后半句小得意。','先疑惑，再短短收住。'):
        result=synthesize(config(),[{'id':'m1','text':'给咪的？','performance_direction':direction}],tmp_path,transport=transport)
        assert result['clips'][0]['instructions'].endswith(direction)
    assert len(posted)==2 and posted[0]['instructions']!=posted[1]['instructions']


def test_private_profile_overrides_legacy_voice(tmp_path,monkeypatch):
    from mukbang import narration,story_profile
    monkeypatch.setenv('BREEZE_API_KEY','test-only')
    monkeypatch.setenv('MUKBANG_BREEZE_VOICE_ID','old_voice')
    monkeypatch.setattr(story_profile,'load',lambda:{'voice_id':'confirmed_clone'})
    selected=narration.configured()
    assert selected.voice_id=='confirmed_clone' and selected.voice_kind=='authorized-reference-clone'
    assert '不故意含糊' in selected.instructions
