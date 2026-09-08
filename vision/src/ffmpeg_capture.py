"""Small capture adapter for remote HLS streams that OpenCV cannot decode.

The vendor replay stream is HEVC over HLS. Debian's OpenCV build can reject
that source even though the system FFmpeg can decode it. This adapter keeps the
stream in memory: FFmpeg samples and downsizes frames into a raw BGR pipe, and
no replay file is written to disk.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any
from urllib.parse import urlparse

import numpy as np


def is_remote_media_source(source: str) -> bool:
    return urlparse(str(source or "")).scheme.lower() in {"http", "https"}


def _binary(name: str, env_name: str) -> str:
    configured = str(os.environ.get(env_name) or "").strip()
    if configured:
        return configured
    ffmpeg_path = str(os.environ.get("FFMPEG_PATH") or "").strip()
    if name == "ffprobe" and ffmpeg_path:
        sibling = os.path.join(os.path.dirname(ffmpeg_path), "ffprobe")
        if os.path.exists(sibling):
            return sibling
    return ffmpeg_path if name == "ffmpeg" and ffmpeg_path else name


class FFmpegRawCapture:
    """Subset of cv2.VideoCapture used by the feeding pipeline."""

    def __init__(self, source: str, output_fps: float = 2.0, max_width: int = 640):
        self.source = str(source or "")
        self.output_fps = max(0.1, float(output_fps or 2.0))
        # All current camera recordings are landscape. A fixed output canvas
        # lets FFmpeg open the HLS source only once; probing and decoding with
        # separate connections can stall this vendor playback session.
        self.width = max(2, int(max_width or 640) // 2 * 2)
        self.height = max(2, round(self.width * 9 / 16) // 2 * 2)
        self.process: subprocess.Popen[bytes] | None = None
        try:
            filters = (
                f"fps={self.output_fps:.6f},"
                f"scale={self.width}:{self.height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,"
                f"pad={self.width}:{self.height}:(ow-iw)/2:(oh-ih)/2"
            )
            self.process = subprocess.Popen(
                [
                    _binary("ffmpeg", "FFMPEG_PATH"),
                    "-hide_banner", "-loglevel", "error",
                    "-rw_timeout", "15000000",
                    "-i", self.source,
                    "-map", "0:v:0", "-an",
                    "-vf", filters,
                    "-pix_fmt", "bgr24",
                    "-f", "rawvideo",
                    "pipe:1",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=max(1024 * 1024, self.width * self.height * 3 * 2),
            )
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
            self.release()

    def isOpened(self) -> bool:  # noqa: N802 - mirrors OpenCV API
        return bool(self.process and self.process.stdout and self.process.poll() is None)

    def get(self, property_id: int) -> float:
        # OpenCV constants: FPS=5, FRAME_WIDTH=3, FRAME_HEIGHT=4.
        if int(property_id) == 5:
            return self.output_fps
        if int(property_id) == 3:
            return float(self.width)
        if int(property_id) == 4:
            return float(self.height)
        return 0.0

    def read(self) -> tuple[bool, np.ndarray | None]:
        if not self.isOpened() or not self.process or not self.process.stdout:
            return False, None
        expected = self.width * self.height * 3
        chunks = bytearray()
        while len(chunks) < expected:
            chunk = self.process.stdout.read(expected - len(chunks))
            if not chunk:
                return False, None
            chunks.extend(chunk)
        frame = np.frombuffer(chunks, dtype=np.uint8).reshape((self.height, self.width, 3))
        return True, frame

    def release(self) -> None:
        process = self.process
        self.process = None
        if not process:
            return
        if process.stdout:
            process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def open_video_capture(
    cv2: Any,
    source: str,
    *,
    output_fps: float = 2.0,
    max_width: int = 640,
) -> Any:
    if is_remote_media_source(source):
        return FFmpegRawCapture(source, output_fps=output_fps, max_width=max_width)
    return cv2.VideoCapture(source)
