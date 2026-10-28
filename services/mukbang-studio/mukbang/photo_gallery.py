"""Versioned relaxed portrait plus diverse ugly-cute gallery; no extra AI."""
from copy import deepcopy

from . import media, photos

MINIMUM_CUTE = 4
MAXIMUM_CUTE = 6


def validate_gallery(raw, frames, duration, *, known_human_visible=False):
    outputs = photos.validate_photos(raw, frames, duration, portrait_partial=True)
    portrait = raw.get("portrait") if isinstance(raw, dict) else None
    if isinstance(portrait, dict) and portrait.get("status") == "not_found":
        if (known_human_visible or portrait.get("human_present") is not False or
                portrait.get("reviewed_all_samples") is not True):
            outputs["portrait"] = {"status": "invalid", "reason": "有人出现就应选出最好的一张同镜合拍；不能因未露脸或角度不够好返回没有"}
        elif outputs["portrait"]["status"] == "not_found":
            outputs["portrait"].update(human_present=False, reviewed_all_samples=True)
    try:
        group = raw.get("ugly_cute") if isinstance(raw, dict) else None
        if not isinstance(group, dict) or group.get("reviewed_all_samples") is not True:
            raise ValueError("丑萌相册必须确认检查全部已提供采样")
        if group.get("status") not in ("ready", "not_found"):
            raise ValueError("丑萌相册状态无效")
        rows = group.get("items")
        if not isinstance(rows, list) or len(rows) > MAXIMUM_CUTE:
            raise ValueError("丑萌相册需要items数组，最多6张")
        if (group["status"] == "not_found") != (len(rows) == 0):
            raise ValueError("丑萌相册状态与照片数量不符")
        shortfall = group.get("shortfall_reason", "")
        if not isinstance(shortfall, str) or len(shortfall) > 1000:
            raise ValueError("照片不足原因必须为短文字")
        shortfall = shortfall.strip()
        if len(rows) < MINIMUM_CUTE and not shortfall:
            raise ValueError("丑萌至少需要4张；不足必须明确说明素材不足，不能默默只选一张")
        if len(rows) >= MINIMUM_CUTE and shortfall:
            raise ValueError("已达到4张目标，不能同时声明数量不足")
        used, items = set(), []
        if outputs["portrait"]["status"] == "ready":
            used.add(outputs["portrait"]["source_frame_index"])
        for row in rows:
            pick = photos.validate_photos({"ugly_cute": row}, frames, duration)["ugly_cute"]
            if pick["status"] != "ready":
                raise ValueError(pick["reason"])
            if pick["source_frame_index"] in used:
                raise ValueError("相册重复引用同一源帧或合拍帧，不能重复凑照片数量")
            used.add(pick["source_frame_index"])
            pick["difference"] = photos._text(row.get("difference"), "与其他照片的可见区别", 500)
            items.append(pick)
        outputs["ugly_cute"] = {"status": group["status"], "items": items, "reviewed_all_samples": True,
                               "reason": shortfall, "count_goal": {"minimum": MINIMUM_CUTE, "maximum": MAXIMUM_CUTE,
                               "actual": len(items), "met": len(items) >= MINIMUM_CUTE, "shortfall_reason": shortfall}}
    except (ValueError, KeyError, TypeError, OverflowError) as exc:
        outputs["ugly_cute"] = {"status": "invalid", "reason": str(exc), "items": []}
    return outputs


def iter_picks(outputs):
    """Flatten only actual photo decisions, not collection-level ready states."""
    for category, result in (outputs or {}).items():
        if isinstance(result.get("items"), list):
            for index, pick in enumerate(result["items"], 1):
                yield f"{category}_{index:02}", pick
        else:
            yield category, result


def ready_count(outputs):
    return sum(pick["status"] == "ready" for _, pick in iter_picks(outputs))


def export_gallery(job_dir, source, decisions, info, sampling, source_hash, cancelled=None, on_step=None):
    flat = dict(iter_picks(decisions))
    exported = photos.export_photos(job_dir, source, flat, info, sampling, source_hash, cancelled, on_step)
    outputs = deepcopy(decisions)
    outputs["portrait"] = exported["portrait"]
    group = outputs["ugly_cute"]
    if group["status"] == "ready":
        group["items"] = [exported[f"ugly_cute_{i:02}"] for i in range(1, len(group["items"])+1)]
        actual = sum(p["status"] == "ready" for p in group["items"])
        group["count_goal"].update(actual=actual, met=actual >= MINIMUM_CUTE)
        if any(p["status"] == "failed" for p in group["items"]):
            group["reason"] = "部分照片本地导出失败；已保留成功照片，未重新调用AI"
            if actual < MINIMUM_CUTE:
                group["count_goal"]["shortfall_reason"] = group["reason"]
        if not actual:
            group["status"] = "failed"
    media.write_json(job_dir / "photo-result.json", outputs)
    return outputs
