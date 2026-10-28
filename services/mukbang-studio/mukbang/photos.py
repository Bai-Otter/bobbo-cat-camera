"""Two independently validated photo picks; native source export, never inference."""
from __future__ import annotations

from copy import deepcopy
from fractions import Fraction
import math
from pathlib import Path

from PIL import Image

from . import media

CATEGORIES = {"portrait": "人宠合拍", "ugly_cute": "丑萌瞬间"}
TRAITS = {"extreme_closeup", "big_nose", "silly_full_face", "tongue_out", "tiny_teeth", "funny_expression"}


def _text(value, label, limit=1000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"照片{label}必须为非空短文字")
    return value.strip()


def validate_photos(raw, frames: list[dict], duration: float, *, portrait_partial=False) -> dict:
    frame_map = {f["id"]: f for f in frames}
    outputs = {}
    for category in CATEGORIES:
        try:
            row = raw.get(category) if isinstance(raw, dict) else None
            if not isinstance(row, dict):
                raise ValueError("模型缺少该类照片结果，不等于没有合格照片")
            if row.get("status") == "not_found":
                if any(row.get(key) is not None for key in ("frame_id", "time", "image_url")):
                    raise ValueError("未找到照片不能同时声明选中帧")
                outputs[category] = {"status": "not_found", "reason": _text(row.get("reason"), "未找到原因")}
                continue
            if row.get("status") != "ready":
                raise ValueError("照片状态只能是ready或not_found")
            ident, moment = row.get("frame_id"), row.get("time")
            frame = frame_map.get(ident) if isinstance(ident, str) else None
            if frame is None:
                raise ValueError("照片引用了不存在的采样帧")
            if (isinstance(moment, bool) or not isinstance(moment, (float, int)) or not math.isfinite(moment)
                    or not 0 <= moment < duration or abs(moment - frame["time"]) > .000001):
                raise ValueError("照片时间与所选采样帧不一致")
            flags = ["pet_face_visible", "clear_enough", "no_major_occlusion"]
            if category == "portrait" and portrait_partial:
                flags = ["human_visible", "pet_visible"]
                if row.get("human_presence") not in ("face", "hand", "leg", "body"):
                    raise ValueError("合拍需说明同镜可见的人脸、手、腿或身体")
            elif category == "portrait":
                flags.append("human_face_visible")
            if any(row.get(flag) is not True for flag in flags):
                raise ValueError("照片未确认本模式所需的主体可见性或清晰条件")
            pick = {"status": "ready", "frame_id": ident, "time": frame["time"],
                    "title": _text(row.get("title"), "标题", 80), "reason": _text(row.get("reason"), "选择理由"),
                    "source_frame_index": frame["source_frame_index"], **{flag: True for flag in flags}}
            if category == "portrait" and portrait_partial:
                pick["human_presence"] = row["human_presence"]
            if category == "ugly_cute":
                traits = row.get("traits")
                if (not isinstance(traits, list) or not 1 <= len(traits) <= 3 or
                        any(not isinstance(t, str) or t not in TRAITS for t in traits) or len(set(traits)) != len(traits)):
                    raise ValueError("丑萌照片必须说明1–3个具体可见的合格特征")
                pick["traits"] = traits[:]
            outputs[category] = pick
        except (ValueError, KeyError, TypeError, OverflowError) as exc:
            outputs[category] = {"status": "invalid", "reason": str(exc)}
    if (all(row["status"] == "ready" for row in outputs.values()) and
            outputs["portrait"]["source_frame_index"] == outputs["ugly_cute"]["source_frame_index"]):
        outputs["ugly_cute"] = {"status": "invalid", "reason": "两类照片选了同一源帧，未重复冒充两张精选，也未自动改选或重试"}
    return outputs


def source_identity(pick: dict, frames: list[dict], info: dict) -> dict:
    frame = next((f for f in frames if f["id"] == pick["frame_id"]), None)
    index = pick["source_frame_index"]
    if (frame is None or type(index) is not int or not 0 <= index < len(info["pts"]) or
            frame["source_frame_index"] != index):
        raise ValueError("照片源帧索引与采样清单不一致")
    pts = info["pts"][index]
    moment = (pts - info["origin_pts"]) * float(Fraction(info["time_base"]))
    if (abs(moment - frame["time"]) > .000001 or abs(moment - pick["time"]) > .000001 or
            frame.get("source_pts", pts) != pts):
        raise ValueError("照片源帧PTS与采样时间不一致")
    return {"source_frame_index": index, "source_pts": pts, "time_base": info["time_base"],
            "source_time": moment, "sample_time": frame["time"]}


def export_photos(job_dir: Path, source: Path, decisions: dict, info: dict, sampling: dict,
                  source_hash: str, cancelled=None, on_step=None) -> dict:
    media.check_cancelled(cancelled)
    outputs = deepcopy(decisions)
    folder = job_dir / "photos"
    folder.mkdir(exist_ok=True)
    valid = []
    for category, pick in outputs.items():
        if pick["status"] != "ready":
            continue
        try:
            pick["source"] = source_identity(pick, sampling["frames"], info)
            valid.append(category)
        except (ValueError, KeyError, TypeError) as exc:
            pick.update(status="failed", reason=str(exc))
    valid.sort(key=lambda category: outputs[category]["source_frame_index"])
    if valid:
        try:
            with media._media_step(on_step, "extract_native_photos", "单次解码提取所选原尺寸照片"):
                expression = media._frame_select_expression([outputs[c]["source_frame_index"] for c in valid])
                media.run(["ffmpeg", "-v", "error", "-nostdin", "-n"] + media.SAFE_INPUT_OPTIONS + [
                    "-i", str(source), "-vf", f"select={expression}", "-fps_mode", "passthrough",
                    "-frames:v", str(len(valid)), "-c:v", "png", "-start_number", "1",
                    str(folder / "selected-%02d.png")], cancelled)
        except media.Cancelled:
            raise
        except Exception as exc:
            media.check_cancelled(cancelled)
            for category in valid:
                outputs[category].update(status="failed", reason=str(exc))
            valid = []
    for index, category in enumerate(valid, 1):
        pick = outputs[category]
        try:
            media.check_cancelled(cancelled)
            with media._media_step(on_step, f"verify_{category}", f"校验{CATEGORIES.get(category, '丑萌照片')}尺寸与完整性"):
                path = folder / f"selected-{index:02}.png"
                with Image.open(path) as image:
                    image.load()
                    if image.format != "PNG" or image.size != (info["width"], info["height"]):
                        raise ValueError("照片格式或尺寸与原视频不一致")
                destination = folder / f"{category}.png"
                if destination.exists():
                    raise ValueError("照片输出已存在，不覆盖既有结果")
                path.rename(destination)
                frame = next(f for f in sampling["frames"] if f["id"] == pick["frame_id"])
                pick.update(image_url=media.artifact_url(job_dir, destination.relative_to(job_dir)),
                            sample_url=frame.get("url"), sheet_id=frame.get("sheet_id"),
                            width=info["width"], height=info["height"], validation={
                                "source_sha256": source_hash, "sha256": media.sha256(destination),
                                "bytes": destination.stat().st_size, "native_dimensions_preserved": True,
                                "exact_sampled_source_frame": True, "additional_visual_api_calls": 0,
                                "crop_applied": False, "image_generation_used": False,
                                "visual_quality_independently_verified": False})
        except media.Cancelled:
            raise
        except Exception as exc:
            media.check_cancelled(cancelled)
            pick.update(status="failed", reason=str(exc))
            pick.pop("image_url", None)
    media.write_json(job_dir / "photo-result.json", outputs)
    return outputs
