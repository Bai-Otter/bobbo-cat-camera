import json
import subprocess
import sys
import unittest


class CliTests(unittest.TestCase):
    def test_cli_analyze_prints_structured_json_for_missing_source(self):
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "src.cli",
                "analyze",
                "--source",
                "",
                "--recording-key",
                "clip-cli",
                "--detector-backend",
                "opencv",
                "--yolo-model",
                "custom.pt",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["recordingKey"], "clip-cli")
        self.assertEqual(payload["target"], "cat")
        self.assertEqual(payload["error"], "SOURCE_MISSING")
        self.assertEqual(payload["markers"], [])
        self.assertEqual(payload["cuteTimeline"], [])
        self.assertEqual(payload["framesSampled"], 0)


if __name__ == "__main__":
    unittest.main()
