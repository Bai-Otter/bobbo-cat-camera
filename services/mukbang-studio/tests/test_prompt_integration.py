"""Real synthetic media through reusable standards; inference stays offline."""
from copy import deepcopy
import json
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
import pytest

from mukbang import media, vision
from mukbang.server import create_app


class OfflineProvider:
    def public(self):
        return {"configured": True, "provider": {"base_url": "https://offline.invalid/v1",
                "model": "gpt-6.1-sol", "api_style": "responses", "key_configured": True}}

    def private(self):
        return {"base_url": "https://offline.invalid/v1", "model": "gpt-6.1-sol",
                "api_style": "responses", "api_key": "OFFLINE_PROMPT_INTEGRATION_ONLY"}


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg is required")
def test_real_media_feedback_proposal_publish_next_video_and_rollback(tmp_path, monkeypatch):
    sources = []
    for index, pattern in enumerate(("testsrc2=size=128x192:rate=10:duration=4",
                                     "color=c=green:size=128x192:rate=10:duration=4")):
        source = tmp_path / f"synthetic-{index}.mp4"
        media.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-f", "lavfi", "-i", pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
        sources.append(source)
    video_calls, text_calls = [], []
    rule = "优先保留自然停顿而不是机械重复的连续相似画面。"

    def offline_inference(prompts, sheets, job_dir, config):
        assert config["model"] == "gpt-6.1-sol"
        payload = vision.make_payload(prompts, sheets, job_dir, config)
        content = payload["input"][0]["content"]
        if not sheets:
            # Exercise the real text adapter and payload construction, not a
            # replacement library worker; there are no image content blocks.
            assert len(content) == 1 and content[0]["type"] == "input_text"
            assert Path(job_dir) == Path(".")
            data = json.loads(prompts["user"][prompts["user"].index("{"):])
            text_calls.append(deepcopy(data))
            value = {"candidate_prompt": data["base_prompt"] + "\n\n" + rule,
                     "summary": "离线测试：依据明确理由补充通用规则",
                     "changes": [{"before": "", "after": rule, "reason": "用户明确写了偏好自然停顿",
                                  "evidence": [{"job_id": data["sources"][0]["job_id"], "frame_id": "F0002"}]}],
                     "warnings": ["合成图形仅验证机制，不验证猫咪审美。"]}
        else:
            assert len(content) == 1 + len(sheets)
            video_calls.append({"prompts": deepcopy(prompts), "job_id": job_dir.name})
            value = {"summary": "synthetic media, no cat assessment", "selected_frames": [
                {"frame_id": "F0002", "score": 95, "reason": "synthetic fixture", "labels": ["fixture"]}],
                "highlight_clips": [{"id": "c01", "start": .5, "end": 2.5,
                    "context_start": .5, "context_end": 2.5, "title": "fixture clip", "reason": "fixture",
                    "score": 95, "frame_ids": ["F0002"]}],
                "memes": [{"id": "m01", "start": .8, "end": 1.6, "title": "fixture meme",
                           "reason": "fixture", "score": 95, "frame_ids": ["F0002"]}], "warnings": []}
        return {"text": json.dumps(value, ensure_ascii=False), "envelope": {"test_only": True},
                "usage": {"total_tokens": 10}, "elapsed_seconds": .01}

    monkeypatch.setattr(vision, "call_vision", offline_inference)
    app = create_app(tmp_path / "data", OfflineProvider())
    manager = app.state.manager
    options = {"target_duration": 2, "min_duration": 1, "max_duration": 3,
               "sample_interval": 1, "use_active_prompt": True}

    def drain():
        manager.executor.submit(lambda: None).result(timeout=45)

    def upload(client, source):
        response = client.post("/api/jobs", data={"options": json.dumps(options)},
                               files={"file": (source.name, source.read_bytes(), "video/mp4")})
        assert response.status_code == 202, response.text
        drain()
        record = client.get(f"/api/jobs/{response.json()['id']}").json()
        assert record["status"] == "completed", record.get("error")
        assert record["result"]["video_duration"] == pytest.approx(2)
        assert record["result"]["validation"]["full_decode_pass"]
        assert record["result"]["memes"][0]["validation"]["full_decode_pass"]
        assert record["ai"]["call_count"] == 1
        return record

    try:
        with TestClient(app) as client:
            first = upload(client, sources[0])
            baseline = first["options"]["prompt"]
            first_dir = manager.jobs_dir / first["id"]
            protected = ["job.json", "prompt.json", "source.mp4", "highlights.mp4", "result.json",
                         *[row["path"] for row in first["sampling"]["frames"]],
                         *[row["path"] for row in first["sampling"]["sheets"]]]
            hashes = {path: media.sha256(first_dir / path) for path in protected}
            saved = client.put(f"/api/jobs/{first['id']}/feedback", json={"expected_version": 0,
                "annotations": [{"frame_id": "F0002", "label": "like", "reason": "喜欢自然的小停顿，不喜欢机械重复"}],
                "note": "请提炼为通用规则"})
            assert saved.status_code == 200
            assert len(video_calls) == 1 and not text_calls
            body = {"expected_revision": 0, "request_id": "offline-real-prompt-proposal-0001",
                    "sources": [{"job_id": first["id"], "feedback_version": 1}]}
            response = client.post("/api/prompt-proposals", json=body)
            assert response.status_code == 202, response.text
            drain()
            proposal = client.get(f"/api/prompt-proposals/{response.json()['id']}").json()
            assert proposal["status"] == "completed", proposal.get("error")
            assert proposal["ai"]["text_call_count"] == 1 and proposal["ai"]["visual_call_count"] == 0
            assert proposal["timings"]["scope"] == "prompt_tuning"
            assert len(text_calls) == 1 and len(video_calls) == 1
            assert client.get("/api/config").json()["prompt_template"] == baseline
            assert client.post("/api/prompt-proposals", json=body).json()["id"] == proposal["id"]
            assert len(text_calls) == 1
            published = client.post("/api/prompt-library/versions", json={"expected_revision": 0,
                "request_id": "offline-real-prompt-publish-0001", "text": proposal["candidate_prompt"],
                "name": "合成媒体验证版", "proposal_id": proposal["id"]})
            assert published.status_code == 201, published.text
            second = upload(client, sources[1])
            assert first["prompt_standard"]["version_id"] == "P0001"
            assert second["prompt_standard"]["version_id"] == "P0002"
            assert rule in second["options"]["prompt"] and rule in video_calls[1]["prompts"]["user"]
            assert first["id"] not in video_calls[1]["prompts"]["user"]
            assert first["options"]["prompt"] == baseline
            rolled_back = client.post("/api/prompt-library/activate", json={"expected_revision": 1,
                "request_id": "offline-real-prompt-rollback-0001", "version_id": "P0001"})
            assert rolled_back.status_code == 200
            assert client.get("/api/config").json()["prompt_template"] == baseline
            assert len(video_calls) == 2 and len(text_calls) == 1
            assert {path: media.sha256(first_dir / path) for path in protected} == hashes
    finally:
        manager.executor.shutdown(wait=True, cancel_futures=True)
