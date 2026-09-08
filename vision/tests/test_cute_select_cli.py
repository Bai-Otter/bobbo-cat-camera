import unittest

from evaluation.cute_select_cli import ALGORITHM_VERSION, select_requests


def evidence_frame(offset: float, score: float) -> dict:
    return {
        "offsetSec": offset,
        "hasCat": True,
        "cuteEvidence": {
            "cuteScore": score,
            "modelConfidence": 0.92,
            "sizeScore": score,
            "pitchScore": 0.8,
            "visibilityScore": 0.9,
            "relationConfidence": 0.9,
            "faceRelation": "toward_camera",
        },
    }


class CuteSelectCliTests(unittest.TestCase):
    def test_selects_each_request_without_mixing_timelines(self):
        frames = [evidence_frame(index * 0.5, 0.8 if 4 <= index <= 12 else 0.4) for index in range(20)]
        result = select_requests({
            "requests": [
                {"id": "meal-a", "durationSec": 10, "frames": frames},
                {"id": "meal-b", "durationSec": 10, "frames": frames},
            ]
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["algorithm"], ALGORITHM_VERSION)
        self.assertEqual([item["id"] for item in result["results"]], ["meal-a", "meal-b"])
        self.assertTrue(all(item["segments"] for item in result["results"]))
        self.assertTrue(all(
            4.0 <= segment["durationSec"] <= 8.0
            for item in result["results"]
            for segment in item["segments"]
        ))

    def test_rejects_a_missing_request_identifier(self):
        with self.assertRaisesRegex(ValueError, "REQUEST_INVALID"):
            select_requests({"requests": [{"frames": []}]})


if __name__ == "__main__":
    unittest.main()
