"""Real media through visual Prompt promotion; inference is offline only."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
import pytest

from mukbang import config, media, vision


class OfflineProvider:
    def public(self):
        return {"configured": True, "provider": {"base_url": "https://offline.invalid/v1",
                "model": "gpt-6.1-sol", "api_style": "responses", "key_configured": True}}

    def private(self):
        return {"base_url": "https://offline.invalid/v1", "model": "gpt-6.1-sol",
                "api_style": "responses", "api_key": "OFFLINE_ROUND_INTEGRATION_ONLY"}


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg is required")
def test_satisfied_round_images_publish_and_next_real_video_use_new_standard(tmp_path, monkeypatch):
    # Importing the default app must not touch the user's application state.
    monkeypatch.setattr(config, "ROOT", tmp_path)
    monkeypatch.setenv("MUKBANG_CODEX_HOME", str(tmp_path / "no-codex"))
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "0")
    from mukbang.server import create_app

    sources = []
    for index, pattern in enumerate(("testsrc2=size=128x192:rate=10:duration=4",
                                     "color=c=green:size=128x192:rate=10:duration=4")):
        source = tmp_path / f"synthetic-round-{index}.mp4"
        media.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-f", "lavfi", "-i", pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
        sources.append(source)

    video_calls, tuning_calls = [], []
    rule = "优先保留面部与鼻口占据画面大部分的自然进食镜头。"

    def offline_inference(prompts, sheets, directory, private):
        assert private["model"] == "gpt-6.1-sol"
        payload = vision.make_payload(prompts, sheets, directory, private)
        assert sheets and len(payload["input"][0]["content"]) == 1 + len(sheets)
        if "实际任务参数（本次真实设置）" in prompts["user"]:
            video_calls.append({"prompt": deepcopy(prompts), "job_id": directory.name})
            value = {"summary": "Synthetic media validates mechanism, not cat cuteness.", "selected_frames": [
                {"frame_id": "F0002", "score": 95, "reason": "synthetic fixture", "labels": ["fixture"]}],
                "highlight_clips": [{"id": "c01", "start": .5, "end": 2.5,
                    "context_start": .5, "context_end": 2.5, "title": "fixture", "reason": "fixture",
                    "score": 95, "frame_ids": ["F0002"]}], "memes": [], "warnings": []}
        else:
            data = json.loads(prompts["user"].split("\n", 1)[1])
            tuning_calls.append({"input": deepcopy(data), "sheets": deepcopy(sheets), "directory": Path(directory)})
            value = {"candidate_prompt": data["tuning_base_prompt"] + "\n\n" + rule,
                     "summary": "Synthetic fixture: transfer the chosen successful round's preference.",
                     "changes": [{"before": "", "after": rule, "reason": "Fixture feedback and visible samples.",
                                  "evidence": [{"job_id": data["sources"][0]["job_id"], "frame_id": "F0002"}]}],
                     "warnings": ["Synthetic media validates the workflow only, not visual taste."]}
        return {"text": json.dumps(value, ensure_ascii=False), "envelope": {"offline_fixture": True},
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
        job = client.get(f"/api/jobs/{response.json()['id']}").json()
        assert job["status"] == "completed", job.get("error")
        assert job["result"]["validation"]["full_decode_pass"]
        return job

    try:
        with TestClient(app) as client:
            first = upload(client, sources[0])
            baseline = first["options"]["prompt"]
            saved = client.put(f"/api/jobs/{first['id']}/feedback", json={"expected_version": 0,
                "annotations": [{"frame_id": "F0002", "label": "like", "reason": "喜欢贴镜头的鼻口"}],
                "note": "只用于这轮的已应用意见"})
            assert saved.status_code == 200, saved.text
            actual_template = baseline + "\n\n这一轮偏好贴近镜头、鼻口可见的画面。"
            revised = client.post(f"/api/jobs/{first['id']}/revise", json={
                "expected_version": 1, "request_id": "real-round-revision-0001",
                "options": {**options, "use_active_prompt": False, "prompt": actual_template}})
            assert revised.status_code == 202, revised.text
            drain()
            satisfied = client.get(f"/api/jobs/{revised.json()['id']}").json()
            assert satisfied["status"] == "completed", satisfied.get("error")
            assert len(video_calls) == 2 and not tuning_calls
            directory = manager.jobs_dir / satisfied["id"]
            hashes = {str(path.relative_to(directory)): media.sha256(path) for path in directory.rglob("*") if path.is_file()}

            # A later edit is deliberately NOT the feedback used for this cut.
            draft = client.get(f"/api/jobs/{satisfied['id']}/feedback").json()
            later = client.put(f"/api/jobs/{satisfied['id']}/feedback", json={
                "expected_version": draft["version"], "annotations": [], "note": "DO_NOT_GENERALIZE_THIS_DRAFT"})
            assert later.status_code == 200
            hashes["feedback-draft.json"] = media.sha256(directory / "feedback-draft.json")

            body = {"expected_revision": 0, "request_id": "real-round-standard-0001", "job_id": satisfied["id"]}
            response = client.post("/api/prompt-proposals/satisfied-round", json=body)
            assert response.status_code == 202, response.text
            drain()
            proposal = client.get(f"/api/prompt-proposals/{response.json()['id']}").json()
            assert proposal["status"] == "completed", proposal.get("error")
            assert proposal["tuning_base_prompt"] == actual_template
            assert proposal["base_prompt"] == baseline
            assert proposal["satisfied_round"]["round"] == 2
            assert proposal["ai"]["visual_call_count"] == 1
            assert proposal["ai"]["text_call_count"] == 0
            assert proposal["ai"]["image_count"] == len(satisfied["sampling"]["sheets"])
            assert len(tuning_calls) == 1 and len(video_calls) == 2
            assert "DO_NOT_GENERALIZE_THIS_DRAFT" not in json.dumps(tuning_calls[0]["input"])
            assert client.get("/api/config").json()["prompt_template"] == baseline
            assert client.post("/api/prompt-proposals/satisfied-round", json=body).json()["id"] == proposal["id"]
            assert len(tuning_calls) == 1

            published = client.post("/api/prompt-library/versions", json={"expected_revision": 0,
                "request_id": "real-round-publish-0001", "text": proposal["candidate_prompt"],
                "name": "合成素材满意轮次通用版", "proposal_id": proposal["id"]})
            assert published.status_code == 201, published.text
            next_video = upload(client, sources[1])
            assert next_video["prompt_standard"]["version_id"] == "P0002"
            assert rule in video_calls[-1]["prompt"]["user"]
            assert "这一轮偏好贴近镜头" in next_video["options"]["prompt"]
            assert satisfied["id"] not in next_video["options"]["prompt"]
            assert "F0002" not in next_video["options"]["prompt"]
            assert next_video["prompt_standard"]["sha256"] == hashlib.sha256(next_video["options"]["prompt"].encode()).hexdigest()
            assert len(tuning_calls) == 1 and len(video_calls) == 3
            assert {name: media.sha256(directory / name) for name in hashes} == hashes
            assert client.get(f"/api/jobs/{satisfied['id']}").json()["options"]["prompt"] == actual_template
    finally:
        manager.executor.shutdown(wait=True, cancel_futures=True)
