import unittest
from unittest.mock import Mock, patch

from src.ffmpeg_capture import FFmpegRawCapture, is_remote_media_source, open_video_capture


class FFmpegCaptureSelectionTests(unittest.TestCase):
    def test_remote_http_sources_use_ffmpeg_capture(self):
        cv2 = Mock()
        sentinel = object()
        with patch("src.ffmpeg_capture.FFmpegRawCapture", return_value=sentinel) as capture:
            result = open_video_capture(
                cv2,
                "https://camera.example/replay.m3u8",
                output_fps=0.5,
                max_width=640,
            )
        self.assertIs(result, sentinel)
        capture.assert_called_once_with(
            "https://camera.example/replay.m3u8",
            output_fps=0.5,
            max_width=640,
        )
        cv2.VideoCapture.assert_not_called()

    def test_local_files_keep_using_opencv(self):
        cv2 = Mock()
        sentinel = object()
        cv2.VideoCapture.return_value = sentinel
        result = open_video_capture(cv2, "recording.mp4")
        self.assertIs(result, sentinel)
        cv2.VideoCapture.assert_called_once_with("recording.mp4")

    def test_only_http_and_https_are_remote_media_sources(self):
        self.assertTrue(is_remote_media_source("https://example.com/a.m3u8"))
        self.assertTrue(is_remote_media_source("http://example.com/a.m3u8"))
        self.assertFalse(is_remote_media_source("rtsp://example.com/live"))
        self.assertFalse(is_remote_media_source("C:/recordings/a.mp4"))

    def test_ffmpeg_capture_uses_one_connection_without_probing(self):
        process = Mock()
        process.poll.return_value = None
        process.stdout = Mock()
        with patch("src.ffmpeg_capture.subprocess.Popen", return_value=process) as popen:
            capture = FFmpegRawCapture(
                "https://camera.example/replay.m3u8",
                output_fps=0.5,
                max_width=640,
            )
        self.assertTrue(capture.isOpened())
        self.assertEqual((capture.width, capture.height), (640, 360))
        command = popen.call_args.args[0]
        self.assertEqual(command.count("https://camera.example/replay.m3u8"), 1)
        self.assertIn("fps=0.500000", command[command.index("-vf") + 1])
        capture.release()


if __name__ == "__main__":
    unittest.main()
