"""Import and annotate old decisions without reviewing any source imagery.

Pillow is used only as a deterministic drawing engine. No AI, visual inspection,
image display, video playback, or new cute-frame decision takes place here.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import shutil

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
VERMILION = "#ed3f24"
NOTICE = (
    "历史复盘：原版只保存了5个片段及峰值时间，没有逐帧的AI圈选记录。"
    "红圈是把这些旧峰值映射到当时拼图中时间最近的采样帧，不是重新进行AI判断，"
    "也不代表剪辑范围里的每帧都被AI评为可爱；同一峰值在不同精查组可各有一圈。"
    "原图保持不变，标注图另存；本次导入没有新增视觉调用。"
)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stamp(seconds: float) -> str:
    millis = round(seconds * 1000)
    return f"{millis // 60000:02}:{millis // 1000 % 60:02}.{millis % 1000:03}"


def round1_tiles(manifest: dict) -> list[dict]:
    geometry = manifest["geometry"]
    columns, tile_width = geometry["columns"], geometry["tile_width"]
    picture_height, label_height = geometry["picture_height"], geometry["label_height"]
    gap, margin, header = 4, 12, 66  # Exact constants from the old prepare_review.py.
    return [
        {
            "id": f"R1-{order + 1:04}", "sheet_id": "round1", "group_id": "overview",
            "index": order, "frame_index": frame["index"], "time": frame["time"],
            "box": [margin + (order % columns) * (tile_width + gap),
                    header + (order // columns) * (picture_height + label_height + gap),
                    tile_width, picture_height + label_height],
            "picture_height": picture_height,
        }
        for order, frame in enumerate(manifest["frames"])
    ]


def round2_tiles(manifest: dict, settings: dict) -> list[dict]:
    columns = settings.get("columns", 12)
    tile_width, tile_height = settings.get("tile_width", 168), settings.get("tile_height", 170)
    gap, margin, label_height, cursor = 5, 12, 24, 72
    tiles = []
    for group_data in manifest["groups"]:
        group, frames = group_data["group"], group_data["frames"]
        cursor += 44
        for order, frame in enumerate(frames):
            tiles.append({
                "id": f"R2-{group['id']}-{order + 1:03}", "sheet_id": "round2",
                "group_id": group["id"], "group_start": group["start"], "group_end": group["end"],
                "index": len(tiles), "frame_index": frame["index"], "time": frame["time"],
                "box": [margin + (order % columns) * (tile_width + gap),
                        cursor + (order // columns) * (tile_height + label_height + gap),
                        tile_width, tile_height + label_height],
                "picture_height": tile_height, "crop": group.get("crop"),
            })
        cursor += math.ceil(len(frames) / columns) * (tile_height + label_height + gap)
    return tiles


def validate_tiles(tiles: list[dict], size: list[int]):
    width, height = size
    for tile in tiles:
        x, y, box_width, box_height = tile["box"]
        if not (x >= 0 and y >= 0 and box_width > 0 and box_height > 0
                and x + box_width <= width and y + box_height <= height):
            raise ValueError(f"标注坐标越界：{tile['id']} {tile['box']} / {size}")


def choose_peak_mappings(clips: list[dict], tiles: list[dict], *, is_overview: bool) -> list[dict]:
    groups = defaultdict(list)
    for tile in tiles:
        groups[tile["group_id"]].append(tile)
    mappings = []
    for clip in clips:
        peak = clip["peak"]
        for group_tiles in groups.values():
            if not is_overview:
                start, end = group_tiles[0]["group_start"], group_tiles[0]["group_end"]
                if not start - 1e-8 <= peak <= end + 1e-8:
                    continue
            nearest = min(group_tiles, key=lambda tile: (abs(tile["time"] - peak), tile["time"]))
            mappings.append({
                **nearest,
                "frame_id": nearest["id"], "selection_id": clip["id"],
                "source_peak": peak, "time_error_seconds": round(abs(nearest["time"] - peak), 9),
                "title": clip["title"], "method": "nearest_sample_to_saved_peak",
                "reason": f"旧版保存的峰值为{stamp(peak)}；此格是本组中离旧峰值最近的采样帧，不是新的AI判断。",
                "original_evidence": clip.get("evidence", ""),
            })
    return mappings


def font(size: int):
    for candidate in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
                      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def annotate(original: Path, destination: Path, mappings: list[dict], size: list[int]):
    validate_tiles(mappings, size)
    with Image.open(original) as input_image:
        if list(input_image.size) != size:
            raise ValueError("原拼图尺寸和采样清单不一致，停止标注。")
        board = input_image.convert("RGB")
    draw = ImageDraw.Draw(board)
    # Only replace the old reserved header; tile positions/dimensions never move.
    draw.rectangle((0, 0, board.width - 1, 62), fill="#171b21")
    draw.text((12, 3), "历史复盘 | 红圈 = 旧版峰值最近采样格（不是重新AI判断）", fill=VERMILION, font=font(23))
    draw.text((12, 35), "原拼图另存不变 · 同峰在不同精查组可重复标记 · 未圈选不代表不可爱", fill="#f6e8d7", font=font(17))
    for mapping in mappings:
        x, y, width, height = mapping["box"]
        picture_height = mapping["picture_height"]
        draw.rectangle((x + 1, y + 1, x + width - 2, y + height - 2), outline=VERMILION, width=4)
        draw.ellipse((x + 5, y + 5, x + width - 6, y + picture_height - 5), outline=VERMILION, width=5)
        label = f"{mapping['selection_id']} 旧峰值"
        label_font = font(15)
        bounds = draw.textbbox((0, 0), label, font=label_font)
        label_width = min(width - 5, bounds[2] - bounds[0] + 8)
        draw.rectangle((x + 3, y + 3, x + 3 + label_width, y + 24), fill=VERMILION)
        draw.text((x + 6, y + 3), label, font=label_font, fill="white")
    board.save(destination, quality=95, subsampling=0)
    with Image.open(destination) as result:
        if list(result.size) != size:
            raise ValueError("标注图尺寸发生变化。")
        result.verify()


def copy_exact(source: Path, destination: Path) -> dict:
    expected = sha256(source)
    shutil.copyfile(source, destination)
    copied, after = sha256(destination), sha256(source)
    if copied != expected or after != expected:
        raise ValueError(f"复制完整性校验失败：{source.name}")
    return {"source": str(source), "destination": destination.name, "sha256": expected,
            "bytes": destination.stat().st_size, "source_unchanged": True}


def import_run(source_project: Path, destination_root: Path, run_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", run_id):
        raise ValueError("非法run_id")
    source_project, destination_root = source_project.resolve(), destination_root.resolve()
    if destination_root == source_project or source_project in destination_root.parents:
        raise ValueError("历史输入目录只读；输出不能位于历史项目内。")
    destination = destination_root / run_id
    destination.mkdir(parents=True, exist_ok=True)
    selections = load_json(source_project / "selections.json")
    clips = sorted((clip for clip in selections["clips"] if clip.get("include", True)), key=lambda clip: clip["order"])
    timeline = load_json(source_project / "source-output-timeline.json")
    r1, r2 = (load_json(source_project / f"sampling-round{number}.json") for number in (1, 2))
    settings = load_json(source_project / "candidate-windows.json")
    tile_sets = (round1_tiles(r1), round2_tiles(r2, settings))
    copied_files, sheets, all_mappings = [], [], []
    prefix = f"/api/legacy/files/{run_id}/"
    for number, manifest, tiles in zip((1, 2), (r1, r2), tile_sets):
        validate_tiles(tiles, manifest["size"])
        filename = "round1-overview.jpg" if number == 1 else "round2-focus.jpg"
        original = destination / filename
        integrity = copy_exact(source_project / filename, original)
        copied_files.append(integrity)
        mappings = choose_peak_mappings(clips, tiles, is_overview=number == 1)
        all_mappings.extend(mappings)
        annotated = destination / f"{original.stem}-annotated.jpg"
        annotate(original, annotated, mappings, manifest["size"])
        sheets.append({
            "id": f"round{number}", "title": f"旧版第{number}轮 · {'全片概览' if number == 1 else '候选精查'}",
            "original_url": prefix + original.name, "annotated_url": prefix + annotated.name,
            "count": len(tiles), "selected_count": len(mappings), "source_filename": filename,
            "width": manifest["size"][0], "height": manifest["size"][1], "sha256": integrity["sha256"],
            "annotated_sha256": sha256(annotated), "mapping_method": "nearest_sample_to_saved_peak",
        })
    selected_frames = []
    for clip in clips:
        still_candidates = list((source_project / "stills").glob(f"*-{clip['id']}.jpg"))
        if len(still_candidates) != 1:
            raise ValueError(f"旧版峰值原帧缺失或重复：{clip['id']}")
        still = destination / f"selected-{clip['id']}.jpg"
        copied_files.append(copy_exact(still_candidates[0], still))
        mappings = [mapping for mapping in all_mappings if mapping["selection_id"] == clip["id"]]
        preferred = next((mapping for mapping in mappings if mapping["sheet_id"] == "round2"), mappings[0])
        selected_frames.append({
            "id": clip["id"], "time": clip["peak"], "title": clip["title"],
            "reason": f"沿用旧版保存的片段峰值。{preferred['reason']}", "url": prefix + still.name,
            "sheet_id": preferred["sheet_id"], "frame_id": preferred["frame_id"],
            "labels": clip.get("labels", []), "confidence": clip.get("confidence"),
            "mapping_count": len(mappings), "original_evidence": clip.get("evidence", ""),
        })
    video = destination / "legacy-highlight-12s.mp4"
    copied_files.append(copy_exact(source_project / "吃播萌点精选-无BGM.mp4", video))
    for filename in ("selections.json", "sampling-round1.json", "sampling-round2.json",
                     "candidate-windows.json", "source-output-timeline.json", "visual-rounds.json"):
        copied_files.append(copy_exact(source_project / filename, destination / f"legacy-{filename}"))
    audit = {
        "run_id": run_id, "method": "nearest_sample_to_saved_peak", "notice": NOTICE,
        "visual_model_calls": 0, "visual_inspections": 0,
        "source_project": str(source_project), "mappings": all_mappings,
        "copied_files": copied_files,
        "validation": {"boxes_in_bounds": True, "all_copies_hash_match": True,
                       "original_sources_unchanged": True, "original_dimensions_preserved": True,
                       "round1_circles": sheets[0]["selected_count"], "round2_circles": sheets[1]["selected_count"]},
    }
    save_json(destination / "selection-audit.json", audit)
    public_timeline = [{
        "id": clip["id"], "title": clip["title"],
        "start": clip["source_start"], "end": clip["source_end"], "peak": clip["source_peak"],
        "output_start": clip["output_start"], "output_end": clip["output_end"],
        "reason": "沿用历史保存的剪辑时间轴；不是本次新识别。",
        "labels": clip.get("labels", []),
    } for clip in timeline["clips"]]
    run = {
        "id": run_id, "title": "上一版 91537215 · 12秒历史结果", "notice": NOTICE,
        "video_url": prefix + video.name, "video_duration": timeline["total_duration"],
        "sheets": sheets, "selected_frames": selected_frames, "timeline": public_timeline,
        "audit_url": prefix + "selection-audit.json", "historical": True,
        "original_visual_rounds": selections["visual_rounds_used"], "new_visual_calls": 0,
    }
    save_json(destination / "run.json", run)
    return run


def update_manifest(destination_root: Path, run: dict):
    manifest_path = destination_root / "manifest.json"
    existing = load_json(manifest_path).get("runs", []) if manifest_path.is_file() else []
    runs = [run] + [item for item in existing if item["id"] != run["id"]]
    save_json(manifest_path, {"runs": runs})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=Path, required=True,
                        help="Historical project directory to import (never modified).")
    parser.add_argument("--destination", type=Path, default=ROOT / "data/legacy")
    parser.add_argument("--run-id", default="91537215")
    args = parser.parse_args()
    run = import_run(args.source_project, args.destination, args.run_id)
    update_manifest(args.destination, run)
    print(json.dumps({"manifest": str(args.destination / "manifest.json"), "run": run["id"],
                      "sheet_counts": [sheet["count"] for sheet in run["sheets"]],
                      "circle_counts": [sheet["selected_count"] for sheet in run["sheets"]],
                      "unique_peaks": len(run["selected_frames"]), "new_visual_calls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
