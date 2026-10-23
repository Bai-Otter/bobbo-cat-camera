"""Zero-AI media benchmark using saved source/timeline, never overwriting jobs.

Call separately for each implementation to avoid concurrent encoders. Results
and generated media belong in an ignored output root, not in source control.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
import tempfile
import time


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--implementation", type=Path, required=True, help="Service root containing mukbang/media.py")
    parser.add_argument("--source-job", type=Path, required=True, help="Read-only saved job directory")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--fingerprint", action="store_true", help="Compare decoded pixels/audio outside measured time")
    args = parser.parse_args()
    implementation = args.implementation.resolve()
    source_job = args.source_job.resolve()
    args.output_root.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="media-bench-", dir=args.output_root.resolve()))
    spec = importlib.util.spec_from_file_location("bench_media", implementation / "mukbang" / "media.py")
    media = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(media)
    source = source_job / "source.mp4"
    timeline = json.loads((source_job / "edit-timeline.json").read_text(encoding="utf-8"))
    calls, details, phases = [], [], {}
    original_run = media.run

    def observed_run(command, *positional, **keywords):
        kind = ("strict_decode" if "null" in command else "encode") if command[0] == "ffmpeg" else (
            "frame_scan" if "-show_frames" in command else "count_scan" if "-count_frames" in command else "metadata")
        started = time.monotonic()
        status = "failed"
        try:
            result = original_run(command, *positional, **keywords)
            status = "completed"
            return result
        finally:
            calls.append({"kind": kind, "seconds": round(time.monotonic() - started, 6), "status": status})

    media.run = observed_run

    def measure(name, operation):
        print(f"Starting {name}", flush=True)
        started = time.monotonic()
        try:
            return operation()
        finally:
            phases[name] = round(time.monotonic() - started, 6)
            print(f"Finished {name}: {phases[name]:.3f}s", flush=True)

    def index():
        metadata = media.probe(source)
        frames = media.frame_times(source)
        info = media.video_info(metadata, frames)
        if media.sha256(source) != timeline["source_sha256"]:
            raise ValueError("Saved source digest does not match timeline")
        return info

    def step(ident, label, seconds, status):
        details.append({"id": ident, "label": label, "seconds": seconds, "status": status})

    info = measure("source_probe", index)
    clips = media.quantize_clips(timeline["clips"], info)
    highlight_kwargs = {"on_step": step} if "on_step" in inspect.signature(media.render_video).parameters else {}
    meme_kwargs = {"on_step": step} if "on_step" in inspect.signature(media.render_meme).parameters else {}
    validation = measure("render_highlight", lambda: media.render_video(source, output / "highlights.mp4", clips, info, **highlight_kwargs))
    memes = measure("export_memes", lambda: [media.render_meme(source, output, meme, info, **meme_kwargs) for meme in timeline["memes"]])
    report = {"label": args.label, "implementation_sha256": media.sha256(implementation / "mukbang" / "media.py"),
              "frame_probe_threads": media.frame_probe_threads() if hasattr(media, "frame_probe_threads") else "automatic",
              "phases": phases, "total_measured_seconds": round(sum(phases.values()), 6),
              "commands": calls.copy(), "details": details, "highlight_validation": validation,
              "meme_validations": [meme["validation"] for meme in memes], "ai_calls": 0,
              "note": "Source index + exports only; excludes sampling, AI, sheet annotations and fingerprints. Sequential local run; not a speed guarantee."}
    if args.fingerprint:
        paths = [output / "highlights.mp4"] + [output / meme["video_path"] for meme in memes] + [output / meme["gif_path"] for meme in memes]
        fingerprints = {}
        for path in paths:
            video = original_run(["ffmpeg", "-v", "error", "-nostdin"] + media.SAFE_INPUT_OPTIONS + [
                "-i", str(path), "-map", "0:v:0", "-f", "framemd5", "-"])
            value = {"video_frame_md5_sha256": hashlib.sha256(video.encode("utf-8")).hexdigest()}
            if info["audio_stream"] and path.suffix == ".mp4":
                value["decoded_audio_sha256"] = original_run(["ffmpeg", "-v", "error", "-nostdin"] + media.SAFE_INPUT_OPTIONS + [
                    "-i", str(path), "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"]).strip()
            fingerprints[path.relative_to(output).as_posix()] = value
        report["fingerprints"] = fingerprints
    media.write_json(output / "benchmark.json", report)
    print(json.dumps({"label": args.label, "phases": phases, "total_measured_seconds": report["total_measured_seconds"],
                      "commands": len(calls), "report": str(output / "benchmark.json")}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
