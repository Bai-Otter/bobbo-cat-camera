from typing import Any


SUPPORTED_ORIENTATIONS = {"none", "clockwise-90"}


def normalize_orientation(value: Any) -> str:
    orientation = str(value or "none").strip().lower()
    return orientation if orientation in SUPPORTED_ORIENTATIONS else "none"


def orient_frame(cv2: Any, frame: Any, orientation: Any) -> Any:
    if normalize_orientation(orientation) == "clockwise-90":
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    return frame
