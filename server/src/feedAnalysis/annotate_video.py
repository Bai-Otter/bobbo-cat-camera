import json
import sys
from pathlib import Path
import cv2

def box(item):
    if not isinstance(item, dict): return None
    try:
        return tuple(int(round(float(item[k]))) for k in ("x", "y", "width", "height"))
    except Exception:
        return None

def state_labels(nearest):
    evidence = nearest.get("cuteEvidence") or {}
    labels = []
    relation = str(nearest.get("faceRelation") or evidence.get("faceRelation") or "")
    relation_labels = {
        "toward_camera": "TOWARD CAMERA",
        "profile_left": "LEFT PROFILE",
        "profile_right": "RIGHT PROFILE",
        "looking_away": "LOOKING AWAY",
        "head_down": "HEAD DOWN",
        "partial": "PARTIAL FACE",
        "unknown": "RELATION UNKNOWN",
    }
    if relation in relation_labels:
        labels.append(relation_labels[relation])
    if evidence.get("extremeCloseup"):
        labels.append("FACE CLOSEUP")
    elif evidence.get("closeup"):
        labels.append("CLOSEUP")
    if evidence.get("front"):
        labels.append("FRONT FACE")
    if evidence.get("headUp"):
        labels.append("HEAD UP")
    if evidence.get("profile"):
        labels.append("LEFT PROFILE" if evidence.get("profileSide") == "left" else "RIGHT PROFILE")
    if nearest.get("eatingVerified"):
        labels.append("EATING")
    elif nearest.get("nearBowl"):
        labels.append("NEAR BOWL")
    return labels or (["CAT DETECTED"] if nearest.get("hasCat") else ["NO CAT"])

def cute_score_label(nearest):
    evidence = nearest.get("cuteEvidence") or {}
    try:
        score = max(0.0, min(1.0, float(evidence.get("cuteScore") or 0)))
    except (TypeError, ValueError):
        score = 0.0
    return f"CUTE {score * 100:.0f}"

def main():
    source, timeline_file, output = sys.argv[1:4]
    timeline = json.loads(Path(timeline_file).read_text(encoding="utf-8"))
    frames = timeline.get("frames", [])
    cap = cv2.VideoCapture(source)
    if not cap.isOpened(): raise RuntimeError("ANNOTATION_VIDEO_OPEN_FAILED")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    writer = cv2.VideoWriter(output, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened(): raise RuntimeError("ANNOTATION_VIDEO_WRITER_FAILED")
    index = 0
    while True:
        ok, image = cap.read()
        if not ok: break
        sec = index / fps
        nearest = min(frames, key=lambda f: abs(float(f.get("offsetSec", f.get("second", 0))) - sec), default={})
        for raw in nearest.get("catBoxes", []):
            b = box(raw)
            if b: x,y,w,h=b; cv2.rectangle(image, (x,y), (x+w,y+h), (0,210,0), 2)
        bowl = box(nearest.get("bowlRoi"))
        if bowl:
            x,y,w,h=bowl; cv2.rectangle(image, (x,y), (x+w,y+h), (255,160,0), 2)
        state = " / ".join(state_labels(nearest))
        state = f"{state} / {cute_score_label(nearest)}"
        reason = str((nearest.get("behaviorEvidence") or {}).get("reason") or "")[:48]
        cv2.rectangle(image, (8,8), (min(width-8, 720), 76 if reason else 48), (0,0,0), -1)
        cv2.putText(image, f"{sec:06.1f}s  {state}", (16,34), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255,255,255), 2, cv2.LINE_AA)
        if reason: cv2.putText(image, reason, (16,64), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (80,190,255), 1, cv2.LINE_AA)
        writer.write(image); index += 1
    cap.release(); writer.release()

if __name__ == "__main__": main()
