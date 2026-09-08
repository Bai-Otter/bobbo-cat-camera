import unittest

import cv2
import numpy as np

from src.orientation import normalize_orientation, orient_frame


class OrientationTests(unittest.TestCase):
    def test_normalizes_supported_orientation(self):
        self.assertEqual(normalize_orientation(" CLOCKWISE-90 "), "clockwise-90")
        self.assertEqual(normalize_orientation("sideways"), "none")

    def test_rotates_frame_clockwise(self):
        frame = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.uint8)

        result = orient_frame(cv2, frame, "clockwise-90")

        np.testing.assert_array_equal(
            result,
            np.array([[4, 1], [5, 2], [6, 3]], dtype=np.uint8),
        )


if __name__ == "__main__":
    unittest.main()
