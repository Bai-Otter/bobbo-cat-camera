import json
import math
import sys
import base64
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


VISION_ROOT = Path(
    os.environ.get("FEED_ANALYSIS_V32_VISION_ROOT")
    or Path(__file__).resolve().parents[3] / "vision-v32"
)
VISION_ROOT_TEXT = str(VISION_ROOT)
if VISION_ROOT_TEXT not in sys.path:
    sys.path.insert(0, VISION_ROOT_TEXT)

from src.opencv_cascades import resolve_haar_cascade_path


CAT_CASCADE_PATH = resolve_haar_cascade_path(
    cv2,
    "haarcascade_frontalcatface_extended.xml",
)
CAT_CASCADE_RELAXED_PATH = resolve_haar_cascade_path(
    cv2,
    "haarcascade_frontalcatface.xml",
)


@dataclass
class Roi:
    x: int
    y: int
    width: int
    height: int

    def to_dict(self):
        return {
            "x": int(self.x),
            "y": int(self.y),
            "width": int(self.width),
            "height": int(self.height),
        }


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def detect_bowl(frame):
    height, width = frame.shape[:2]
    search_top = height // 2
    roi = frame[search_top:, :]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (9, 9), 2)
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(20, width // 6),
        param1=100,
        param2=20,
        minRadius=max(12, width // 30),
        maxRadius=max(40, width // 5),
    )
    if circles is None:
      return None, 0.0
    circle = max(circles[0], key=lambda item: item[2])
    x, y, radius = circle
    roi_obj = Roi(
        x=int(clamp(x - radius, 0, width)),
        y=int(clamp(search_top + y - radius, 0, height)),
        width=int(radius * 2),
        height=int(radius * 2),
    )
    confidence = float(clamp(radius / max(width, height) * 8.0, 0.2, 0.95))
    return roi_obj, confidence


def detect_cat_faces(frame, classifier, relaxed=False):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    attempts = [
        (classifier, 1.08, 3, (48, 48)),
    ]
    if relaxed:
        relaxed_classifier = cv2.CascadeClassifier(CAT_CASCADE_RELAXED_PATH)
        attempts.extend([
            (relaxed_classifier, 1.01, 2, (48, 48)),
            (classifier, 1.01, 3, (48, 48)),
        ])
    boxes = []
    seen = set()
    for attempt_classifier, scale_factor, min_neighbors, min_size in attempts:
        faces = attempt_classifier.detectMultiScale(
            gray,
            scaleFactor=scale_factor,
            minNeighbors=min_neighbors,
            minSize=min_size,
        )
        for (x, y, w, h) in faces:
            key = (int(x), int(y), int(w), int(h))
            if key in seen:
                continue
            seen.add(key)
            boxes.append({"x": key[0], "y": key[1], "width": key[2], "height": key[3]})
        if boxes:
            break
    return boxes


def expand_roi(roi, factor):
    width = roi["width"]
    height = roi["height"]
    grow_w = int(width * factor)
    grow_h = int(height * factor)
    return {
        "x": roi["x"] - grow_w,
        "y": roi["y"] - grow_h,
        "width": width + grow_w * 2,
        "height": height + grow_h * 2,
    }


def rects_overlap(a, b):
    return not (
        a["x"] + a["width"] < b["x"]
        or b["x"] + b["width"] < a["x"]
        or a["y"] + a["height"] < b["y"]
        or b["y"] + b["height"] < a["y"]
    )


def centers_close(cat_box, bowl_box):
    cat_cx = cat_box["x"] + cat_box["width"] / 2
    cat_cy = cat_box["y"] + cat_box["height"] / 2
    bowl_cx = bowl_box["x"] + bowl_box["width"] / 2
    bowl_cy = bowl_box["y"] + bowl_box["height"] / 2
    distance = math.hypot(cat_cx - bowl_cx, cat_cy - bowl_cy)
    return distance <= max(bowl_box["width"], bowl_box["height"]) * 1.8


def marker(marker_type, marker_ts_ms, begin_time, end_time):
    return {
        "markerType": marker_type,
        "markerTsMs": int(marker_ts_ms),
        "beginTime": begin_time,
        "endTime": end_time,
    }


def marker_with_id(event_id, marker_type, marker_ts_ms, begin_time, end_time):
    item = marker(marker_type, marker_ts_ms, begin_time, end_time)
    item["eventId"] = event_id
    return item


def format_timestamp_ms(begin_ms, second):
    moment = begin_ms + int(second) * 1000
    return moment


def ms_to_text(ms):
    return cv2.strftime("%Y-%m-%d %H:%M:%S", cv2.gapi.wip.draw.Text(str(ms), (0, 0), 0, 0.5, (0, 0, 0)))


def ms_to_iso_text(ms):
    import datetime

    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


def build_markers(begin_ms, frames):
    markers = []
    has_cat = False
    has_feeding = False
    cat_positive_start = None
    cat_negative_start = None
    feeding_positive_start = None
    feeding_negative_start = None
    cat_entered = False
    feeding_started = False

    for frame in frames:
        second = int(frame["second"])
        if frame["hasCat"]:
            has_cat = True
            cat_negative_start = None
            if cat_positive_start is None:
                cat_positive_start = second
            if not cat_entered and second - cat_positive_start >= 1:
                cat_entered = True
                ts = format_timestamp_ms(begin_ms, cat_positive_start)
                markers.append(marker("cat_enter", ts, ms_to_iso_text(ts), ms_to_iso_text(ts)))
        else:
            cat_positive_start = None
            if cat_entered:
                if cat_negative_start is None:
                    cat_negative_start = second
                if second - cat_negative_start >= 4:
                    ts = format_timestamp_ms(begin_ms, cat_negative_start)
                    markers.append(marker("cat_leave", ts, ms_to_iso_text(ts), ms_to_iso_text(ts)))
                    cat_entered = False

        if frame["nearBowl"]:
            feeding_negative_start = None
            if feeding_positive_start is None:
                feeding_positive_start = second
            if not feeding_started and second - feeding_positive_start >= 7:
                has_feeding = True
                feeding_started = True
                ts = format_timestamp_ms(begin_ms, feeding_positive_start)
                markers.append(marker("feeding_start", ts, ms_to_iso_text(ts), ms_to_iso_text(ts)))
        else:
            feeding_positive_start = None
            if feeding_started:
                if feeding_negative_start is None:
                    feeding_negative_start = second
                if second - feeding_negative_start >= 9:
                    ts = format_timestamp_ms(begin_ms, feeding_negative_start)
                    markers.append(marker("feeding_end", ts, ms_to_iso_text(ts), ms_to_iso_text(ts)))
                    feeding_started = False

    if feeding_started and len(frames) > 0:
        ts = format_timestamp_ms(begin_ms, frames[-1]["second"])
        markers.append(marker("feeding_end", ts, ms_to_iso_text(ts), ms_to_iso_text(ts)))

    return {
        "hasCat": has_cat,
        "hasFeeding": has_feeding,
        "markers": markers,
    }


def parse_begin_ms(recording):
    import datetime

    begin = recording.get("BeginTime") or recording.get("beginTime")
    if not begin:
        return 0
    normalized = str(begin).replace("-", "/")
    dt = datetime.datetime.strptime(normalized, "%Y/%m/%d %H:%M:%S")
    return int(dt.timestamp() * 1000)


def parse_alarm_ms(alarm):
    import datetime

    for key in ("occurredAtMs", "markerTsMs", "timestamp"):
        value = alarm.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return int(value if value > 1000000000000 else value * 1000)
    for key in ("occurredAt", "AlarmTime", "alarmTime", "time", "Time"):
        value = alarm.get(key)
        if not value:
            continue
        normalized = str(value).replace("-", "/")
        try:
            return int(datetime.datetime.strptime(normalized, "%Y/%m/%d %H:%M:%S").timestamp() * 1000)
        except ValueError:
            continue
    return 0


def read_image(source_url):
    if not source_url:
        return None
    source = str(source_url)
    try:
        if source.startswith("data:image/") and "," in source:
            raw = base64.b64decode(source.split(",", 1)[1])
            data = np.frombuffer(raw, dtype=np.uint8)
            return cv2.imdecode(data, cv2.IMREAD_COLOR)
        if source.startswith("http://") or source.startswith("https://"):
            request = urllib.request.Request(source, headers={"User-Agent": "cat-camera-feed-analysis/1.0"})
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read(10 * 1024 * 1024)
            data = np.frombuffer(raw, dtype=np.uint8)
            return cv2.imdecode(data, cv2.IMREAD_COLOR)
        return cv2.imread(source)
    except Exception:
        return None


def analyze_snapshot(payload):
    snapshot_url = payload.get("snapshotUrl") or ""
    alarm = payload.get("alarm") or {}
    provided_bowl = payload.get("bowlRoi")
    frame = read_image(snapshot_url)
    if frame is None:
        return {
            "hasCat": False,
            "hasFeeding": False,
            "analysisConfidence": 0,
            "bowlRoi": provided_bowl,
            "markers": [],
            "frames": [],
            "error": "SNAPSHOT_OPEN_FAILED",
        }

    classifier = cv2.CascadeClassifier(CAT_CASCADE_PATH)
    bowl_roi = provided_bowl
    bowl_confidence = 0.0
    if bowl_roi is None:
        detected_roi, confidence = detect_bowl(frame)
        if detected_roi is not None:
            bowl_roi = detected_roi.to_dict()
            bowl_confidence = confidence

    faces = detect_cat_faces(frame, classifier, relaxed=True)
    has_cat = len(faces) > 0
    near_bowl = False
    if has_cat and bowl_roi:
        expanded_bowl = expand_roi(bowl_roi, 0.4)
        near_bowl = any(rects_overlap(face, expanded_bowl) or centers_close(face, bowl_roi) for face in faces)

    has_feeding = bool(has_cat and near_bowl)
    confidence = 0.92 if has_feeding else 0.72 if has_cat else 0.12
    alarm_ms = parse_alarm_ms(alarm)
    begin_time = ms_to_iso_text(alarm_ms) if alarm_ms else ""
    event_id = f"{alarm.get('id') or alarm.get('AlarmID') or alarm.get('alarmId') or 'alarm'}__feeding_start"
    markers = []
    if has_feeding and alarm_ms:
        markers.append(marker_with_id(event_id, "feeding_start", alarm_ms, begin_time, begin_time))

    return {
        "hasCat": has_cat,
        "hasFeeding": has_feeding,
        "analysisConfidence": confidence or bowl_confidence,
        "bowlRoi": bowl_roi,
        "markers": markers,
        "frames": [
            {
                "second": 0,
                "hasCat": has_cat,
                "nearBowl": near_bowl,
                "confidence": confidence,
                "bowlRoi": bowl_roi,
            }
        ],
        "error": "",
    }


def analyze_stream(payload):
    source_url = payload.get("sourceUrl") or ""
    recording = payload.get("recording") or {}
    provided_bowl = payload.get("bowlRoi")
    classifier = cv2.CascadeClassifier(CAT_CASCADE_PATH)
    capture = cv2.VideoCapture(source_url)
    if not capture.isOpened():
        return {
            "hasCat": False,
            "hasFeeding": False,
            "analysisConfidence": 0,
            "bowlRoi": provided_bowl,
            "markers": [],
            "frames": [],
            "error": "VIDEO_OPEN_FAILED",
        }

    fps = capture.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, int(round(fps)))
    frame_index = 0
    sample_index = 0
    frames = []
    bowl_roi = provided_bowl
    bowl_confidence = 0.0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if frame_index % step != 0:
            frame_index += 1
            continue

        second = sample_index
        sample_index += 1

        if bowl_roi is None:
            detected_roi, confidence = detect_bowl(frame)
            if detected_roi is not None:
                bowl_roi = detected_roi.to_dict()
                bowl_confidence = max(bowl_confidence, confidence)

        faces = detect_cat_faces(frame, classifier)
        has_cat = len(faces) > 0
        near_bowl = False
        if has_cat and bowl_roi:
            expanded_bowl = expand_roi(bowl_roi, 0.4)
            near_bowl = any(rects_overlap(face, expanded_bowl) or centers_close(face, bowl_roi) for face in faces)

        confidence = 0.92 if has_cat else 0.12
        frames.append(
            {
                "second": second,
                "hasCat": has_cat,
                "nearBowl": near_bowl,
                "confidence": confidence,
                "bowlRoi": bowl_roi,
            }
        )
        frame_index += 1

    capture.release()
    begin_ms = parse_begin_ms(recording)
    summary = build_markers(begin_ms, frames)
    confidence_values = [frame["confidence"] for frame in frames if frame["hasCat"] or frame["nearBowl"]]
    analysis_confidence = round(float(sum(confidence_values) / len(confidence_values)), 3) if confidence_values else 0.0
    return {
        "hasCat": summary["hasCat"],
        "hasFeeding": summary["hasFeeding"],
        "analysisConfidence": analysis_confidence or bowl_confidence,
        "bowlRoi": bowl_roi,
        "markers": summary["markers"],
        "frames": frames,
        "error": "",
    }


def analyze_v1_recording(payload):
    from src.analyzer import analyze_recording

    recording = payload.get("recording") or {}
    return analyze_recording(
        {
            "sourceUrl": payload.get("sourceUrl") or "",
            "recordingKey": payload.get("recordingKey") or "",
            "beginTime": (
                payload.get("beginTime")
                or recording.get("BeginTime")
                or recording.get("beginTime")
                or ""
            ),
            "bowlRoi": payload.get("bowlRoi"),
            "detectionTarget": payload.get("detectionTarget") or "cat",
            "detectorBackend": payload.get("detectorBackend") or "auto",
            "yoloModel": payload.get("yoloModel") or "",
            "autoBowlDetection": bool(payload.get("autoBowlDetection")),
            "cuteAnalysisAllScales": bool(payload.get("cuteAnalysisAllScales")),
        }
    )


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    mode = payload.get("mode") or "recording"
    if mode == "snapshot":
        result = analyze_snapshot(payload)
    else:
        result = analyze_v1_recording(payload)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
