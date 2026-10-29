"""Add paid narration to a validated story without another vision call.

Prepare into a new directory. --publish requires the exact serving port stopped,
compares original record hashes, and backs up records before changing pointers.
"""
from copy import deepcopy
import argparse
import json
from pathlib import Path
import shutil
import socket
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang import media, narration, story_subtitles


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--story-result", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--port", type=int, default=8883)
    args = parser.parse_args()
    job_dir, stage = args.job_dir.resolve(), args.output_dir.resolve()
    if not stage.is_relative_to(job_dir) or stage == job_dir:
        raise RuntimeError("Output must be a new child directory of the selected job")
    if args.publish:
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", args.port)) == 0:
                raise RuntimeError("Stop the exact idle serving process before publishing")
        audit = read(stage / "postprocess.json")
        for name, digest in audit["original_hashes"].items():
            if media.sha256(job_dir / name) != digest:
                raise RuntimeError("Original task changed; refusing to publish")
        backup = stage / "previous"
        backup.mkdir(exist_ok=False)
        for name in ("job.json", "result.json", "story-result.json"):
            shutil.copy2(job_dir / name, backup / name)
            media.write_json(job_dir / name, read(stage / name))
        print("Published narrated story; previous records and all original media preserved")
        return
    started = time.monotonic()
    if stage.exists():
        raise RuntimeError("Choose a new output directory; previous results are never overwritten")
    stage.mkdir(parents=True)
    job = read(job_dir / "job.json")
    if job["status"] != "completed":
        raise RuntimeError("Only completed tasks can be narrated")
    story = read(args.story_result)
    if story["status"] != "ready" or not story.get("inner_monologues"):
        raise RuntimeError("A validated story with captions is required")
    hashes = {name: media.sha256(job_dir / name) for name in
              ("job.json", "result.json", "story-result.json", "ai-raw-response.txt", "prompt.json", "timings.json", "source.mp4")}
    media.write_json(stage / "input-story.json", story)
    speech = narration.synthesize(narration.configured(), story["inner_monologues"], stage / "narration")
    media.write_json(stage / "story-narration.json", speech)
    cues = narration.align_cues(story["inner_monologues"], story["clips"], speech["clips"])
    pts = read(job_dir / "source-pts.json")
    frames = [{"best_effort_timestamp": p, "duration": (pts["pts"][i+1] if i+1 < len(pts["pts"]) else pts["end_pts"])-p}
              for i,p in enumerate(pts["pts"])]
    info = media.video_info(read(job_dir / "source-metadata.json"), frames)
    subs = story_subtitles.write_subtitles(stage, cues, info)
    steps = []
    validation = media.render_video(job_dir / "source.mp4", stage / "interaction-story.mp4", story["clips"], info,
                                   subtitle_file=subs["ass"], on_step=lambda ident,label,seconds,status:
                                   steps.append(dict(id=ident,label=label,seconds=seconds,status=status)))
    mixed = narration.mix_video(stage / "interaction-story.mp4", stage / "interaction-story-voiced.mp4", cues, speech, stage / "narration")
    media.write_json(stage / "story-narration.json", {**speech, "cues": cues, "mix": mixed})
    audit = {"kind": "paid_breeze_narration", "seconds": round(time.monotonic()-started,3),
             "additional_visual_ai_calls": 0, "source_unchanged": True, "original_hashes": hashes,
             "steps": [{"id":"story_tts","label":"付费配音生成与订阅核验","seconds":speech["seconds"],"status":"completed"},
                       *steps, {"id":"mix","label":"原声与配音混合","seconds":mixed["mix_seconds"],"status":"completed"},
                       {"id":"mixed_validation","label":"配音成片完整校验","seconds":mixed["validation_seconds"],"status":"completed"}],
             "note":"在原片已批准片段上加入付费女宝宝配音；按真实声音时长调整字幕。原视觉判断与首次生成耗时未改变，无BGM。"}
    for name,digest in hashes.items():
        if media.sha256(job_dir/name) != digest:
            raise RuntimeError("Original input changed while preparing narration")
    asset = lambda name: media.artifact_url(job_dir, (stage/name).relative_to(job_dir))
    output = {**story, "story_mode":"inner_monologue", "inner_monologues":cues,
              "video_url":asset("interaction-story-voiced.mp4"), "subtitle_url":asset("interaction-story.srt"),
              "subtitle_timeline_url":asset("story-narration.json"), "narration":{**speech,"mix":mixed},
              "validation":{**story.get("validation",{}), **validation, **mixed,
                            "subtitle_sha256":media.sha256(subs["ass"]), "additional_visual_api_calls":0},
              "previous_local_postprocess":story.get("local_postprocess"), "local_postprocess":audit}
    result = deepcopy(job["result"])
    result["story"] = output
    result.setdefault("warnings",[]).append(audit["note"])
    job.update(result=result, message="小剧场已加入小布女宝宝配音、原声和字幕，无BGM；本地配音耗时另列，原AI结果保留。")
    for name,value in (("postprocess.json",audit),("story-result.json",output),("result.json",result),("job.json",job)):
        media.write_json(stage/name,value)
    print(json.dumps({"output":str(stage/"interaction-story-voiced.mp4"),"seconds":audit["seconds"],
                      "tts_seconds":speech["seconds"],"audio_durations":[a["duration"] for a in speech["clips"]]},ensure_ascii=False))


if __name__ == "__main__":
    main()
