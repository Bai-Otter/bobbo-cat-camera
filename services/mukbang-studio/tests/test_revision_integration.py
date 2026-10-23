"""HTTP upload + feedback + real cached revision/render, entirely offline."""
from copy import deepcopy
import json
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
import pytest

from mukbang import media, vision
from mukbang.server import create_app


class OfflineProvider:
    """Never instantiate the real provider or read environment credentials."""
    def public(self):
        return {"configured": True, "provider": {"base_url": "https://offline.invalid/v1",
                "model": "synthetic-fixture", "api_style": "responses", "key_configured": True}}

    def private(self):
        return {"base_url": "https://offline.invalid/v1", "model": "synthetic-fixture",
                "api_style": "responses", "api_key": "OFFLINE_INTEGRATION_KEY"}


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg is required")
def test_upload_feedback_and_idempotent_revision_use_real_cached_pipeline(tmp_path, monkeypatch):
    source = tmp_path / "synthetic.mp4"
    media.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-f", "lavfi", "-i", "testsrc2=size=128x192:rate=10:duration=6",
               "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=6",
               "-ac", "2", "-c:a", "aac", "-b:a", "48k", "-c:v", "libx264",
               "-pix_fmt", "yuv420p", str(source)])
    calls = []

    def offline_vision(prompts, sheets, job_dir, model_config):
        # Only inference is replaced: actual payload construction verifies the
        # precise persisted image hashes and includes every sheet in one call.
        assert model_config["model"] == "synthetic-fixture"
        assert model_config["api_key"] == "OFFLINE_INTEGRATION_KEY"
        payload = vision.make_payload(prompts, sheets, job_dir, model_config)
        assert len(payload["input"][0]["content"]) == 1 + len(sheets)
        calls.append({"job_id": job_dir.name, "prompts": deepcopy(prompts), "sheet_count": len(sheets)})
        revised = len(calls) == 2
        first = "F0003" if revised else "F0002"
        left, right = (1.5, 3.5) if revised else (.5, 2.5)
        response = {"summary": "synthetic offline integration, not a cat assessment", "selected_frames": [
            {"frame_id": first, "score": 95, "reason": "synthetic test evidence", "labels": ["fixture"]},
            {"frame_id": "F0005", "score": 90, "reason": "synthetic retained evidence", "labels": ["fixture"]}],
            "highlight_clips": [
                {"id": "c01", "start": left, "end": right, "context_start": left, "context_end": right,
                 "title": "fixture one", "reason": "synthetic event one", "score": 95, "frame_ids": [first]},
                {"id": "c02", "start": 3.5, "end": 5.5, "context_start": 3.5, "context_end": 5.5,
                 "title": "fixture two", "reason": "synthetic event two", "score": 90, "frame_ids": ["F0005"]}],
            "memes": [{"id": "m01", "start": left, "end": left + 1.2, "title": "fixture meme",
                       "reason": "synthetic short event", "score": 95, "frame_ids": [first]}], "warnings": []}
        return {"text": json.dumps(response), "envelope": {"test_only": True}, "usage": {}, "elapsed_seconds": .01}

    monkeypatch.setattr(vision, "call_vision", offline_vision)
    app = create_app(tmp_path / "data", OfflineProvider())
    manager = app.state.manager
    options = {"target_duration": 4, "min_duration": 3, "max_duration": 5,
               "sample_interval": 1, "prompt": "offline API integration prompt"}
    try:
        with TestClient(app) as client:
            response = client.post("/api/jobs", data={"options": json.dumps(options)},
                                   files={"file": ("synthetic.mp4", source.read_bytes(), "video/mp4")})
            assert response.status_code == 202, response.text
            parent_id = response.json()["id"]
            manager.executor.submit(lambda: None).result(timeout=45)
            parent = client.get(f"/api/jobs/{parent_id}").json()
            assert parent["status"] == "completed", parent.get("error")
            assert len(calls) == parent["ai"]["call_count"] == 1
            parent_dir = manager.jobs_dir / parent_id
            immutable_paths = ["source.mp4", "source-metadata.json", "source-pts.json", "sampling.json",
                               "input-cache-integrity.json", "job.json", "result.json", "prompt.json",
                               *[frame["path"] for frame in parent["sampling"]["frames"]],
                               *[sheet["path"] for sheet in parent["sampling"]["sheets"]]]
            original_hashes = {path: media.sha256(parent_dir / path) for path in immutable_paths}
            feedback = {"expected_version": 0, "annotations": [
                {"frame_id": "F0002", "label": "dislike", "reason": "不喜欢这帧低头的感觉"},
                {"frame_id": "F0003", "label": "like", "reason": "更喜欢这帧完整正脸"}],
                "note": "优先完整正脸，不要把不喜欢帧当可爱证据"}
            saved = client.put(f"/api/jobs/{parent_id}/feedback", json=feedback)
            assert saved.status_code == 200 and saved.json()["version"] == 1
            assert len(calls) == 1  # Saving/reading a draft costs no model request.
            assert client.get(f"/api/jobs/{parent_id}/feedback").json() == saved.json()

            real_probe, real_frame_times = media.probe, media.frame_times
            output_probes, output_pts = [], []

            def forbid_input_probe(path, *args, **kwargs):
                assert Path(path).name != "source.mp4", "revision must not probe cached source"
                output_probes.append(Path(path).name)
                return real_probe(path, *args, **kwargs)

            def forbid_input_pts(path, *args, **kwargs):
                assert Path(path).name != "source.mp4", "revision must not decode source PTS again"
                output_pts.append(Path(path).name)
                return real_frame_times(path, *args, **kwargs)

            def forbid_resampling(*args, **kwargs):
                raise AssertionError("revision must not sample video or rebuild contact sheets")

            monkeypatch.setattr(media, "probe", forbid_input_probe)
            monkeypatch.setattr(media, "frame_times", forbid_input_pts)
            monkeypatch.setattr(media, "sample_video", forbid_resampling)
            monkeypatch.setattr(media, "create_sheets", forbid_resampling)
            body = {"expected_version": 1, "request_id": "offline-real-pipeline-revision-0001", "options": options}
            revised = client.post(f"/api/jobs/{parent_id}/revise", json=body)
            assert revised.status_code == 202, revised.text
            child_id = revised.json()["id"]
            manager.executor.submit(lambda: None).result(timeout=45)
            child = client.get(f"/api/jobs/{child_id}").json()
            assert child["status"] == "completed", child.get("error")
            assert len(calls) == 2 and child["ai"]["call_count"] == 1
            assert child["iteration"]["parent_job_id"] == child["iteration"]["root_job_id"] == parent_id
            assert child["iteration"]["round"] == 2 and child["iteration"]["reused_sampling"]
            assert child["result"]["video_duration"] == pytest.approx(4)
            assert child["result"]["validation"]["full_decode_pass"]
            assert child["result"]["validation"]["source_speed_preserved"]
            assert child["result"]["validation"]["audio_sample_rate"] == 8000
            assert child["result"]["validation"]["audio_channels"] == 2
            assert len(child["result"]["memes"]) == 1
            assert child["result"]["memes"][0]["validation"]["full_decode_pass"]
            assert "highlights.mp4" in output_probes and "highlights.mp4" in output_pts
            assert "m01.mp4" in output_probes and "m01.gif" in output_probes
            stages = {row["id"]: row for row in child["timings"]["stages"]}
            assert child["timings"]["status"] == "completed"
            assert stages["reuse_inputs"]["status"] == "completed" and stages["reuse_inputs"]["seconds"] >= 0
            for name in ("upload", "source_probe", "extract_frames", "build_sheets"):
                assert stages[name]["status"] == "skipped" and stages[name]["seconds"] is None
            assert all(stages[name]["status"] == "completed" for name in
                       ("ai_request", "render_highlight", "export_memes", "final_validation"))
            assert sum(row["seconds"] or 0 for row in child["timings"]["stages"]) == pytest.approx(
                child["timings"]["total_seconds"], abs=.00001)
            assert child["comparison"]["added_frame_ids"] == ["F0003"]
            assert child["comparison"]["removed_frame_ids"] == ["F0002"]
            assert child["comparison"]["kept_frame_ids"] == ["F0005"]
            assert child["comparison"]["liked_selected_ids"] == ["F0003"]
            assert child["comparison"]["disliked_selected_ids"] == []
            assert child["comparison"]["disliked_removed_ids"] == ["F0002"]
            actual_prompt = calls[1]["prompts"]["user"]
            assert '"round": 2' in actual_prompt and '"target_duration_seconds": 4.0' in actual_prompt
            assert '"source_time_seconds": 2.0' in actual_prompt
            assert feedback["note"] in actual_prompt
            assert all(annotation["reason"] in actual_prompt for annotation in feedback["annotations"])
            child_dir = manager.jobs_dir / child_id
            assert json.loads((child_dir / "prompt.json").read_text(encoding="utf-8"))["user"] == actual_prompt
            assert json.loads((child_dir / "comparison.json").read_text(encoding="utf-8")) == child["comparison"]
            assert media.sha256(child_dir / "source.mp4") == original_hashes["source.mp4"]
            for sheet in parent["sampling"]["sheets"]:
                assert media.sha256(child_dir / sheet["path"]) == original_hashes[sheet["path"]]
            assert all(media.sha256(parent_dir / path) == digest for path, digest in original_hashes.items())
            assert [frame["source_pts"] for frame in child["sampling"]["frames"]] == [
                frame["source_pts"] for frame in parent["sampling"]["frames"]]
            assert all(f"/jobs/{child_id}/" in frame["url"] for frame in child["sampling"]["frames"])
            assert client.get(child["result"]["video_url"], headers={"Range": "bytes=0-31"}).status_code == 206
            repeated = client.post(f"/api/jobs/{parent_id}/revise", json=body)
            assert repeated.status_code == 202 and repeated.json()["id"] == child_id
            manager.executor.submit(lambda: None).result(timeout=5)
            assert len(calls) == 2
            assert len(client.get("/api/jobs").json()["jobs"]) == 2
            assert client.get(f"/api/jobs/{parent_id}/iterations").json()["jobs"][1]["id"] == child_id
    finally:
        manager.executor.shutdown(wait=True, cancel_futures=True)
