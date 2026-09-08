from __future__ import annotations

import os
from pathlib import Path
from typing import Any


DEFAULT_HAAR_CASCADE_DIRS = (
    "/usr/share/opencv4/haarcascades",
    "/usr/local/share/opencv4/haarcascades",
)


def resolve_haar_cascade_path(cv2_module: Any, filename: str) -> str:
    candidates = [os.getenv("OPENCV_HAAR_CASCADES", "")]
    cv2_data = getattr(cv2_module, "data", None)
    candidates.append(getattr(cv2_data, "haarcascades", ""))
    candidates.extend(DEFAULT_HAAR_CASCADE_DIRS)

    checked = []
    for directory in candidates:
        if not directory:
            continue
        path = Path(directory) / filename
        path_text = str(path)
        if path_text in checked:
            continue
        checked.append(path_text)
        if path.is_file():
            return path_text

    raise RuntimeError(
        f"OpenCV Haar cascade {filename!r} was not found; checked: {', '.join(checked)}"
    )
