import unittest


from src.cute_highlights import evaluate_cute_face, smooth_cute_frames


def catflw_landmarks(*, left_eye=(800, 400), right_eye=(1120, 400), muzzle=(960, 610)):
    landmarks = [[960.0, 500.0] for _ in range(48)]
    landmarks[4] = [float(left_eye[0]), float(left_eye[1])]
    landmarks[8] = [float(right_eye[0]), float(right_eye[1])]
    for index, delta in zip((16, 17, 46, 47), ((0, -8), (0, 8), (-18, 0), (18, 0))):
        landmarks[index] = [float(muzzle[0] + delta[0]), float(muzzle[1] + delta[1])]
    return landmarks


class CuteHighlightTests(unittest.TestCase):
    frame_shape = (1080, 1920, 3)

    def test_policy_can_narrow_eligibility_without_changing_raw_score(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(),
            self.frame_shape,
            model_confidence=0.9,
            policy={"minCuteScore": 0.99},
        )
        self.assertGreater(result["cuteScore"], 0)
        self.assertFalse(result["strictEligible"])

    def test_large_symmetric_face_is_closeup_and_front_facing(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(),
            self.frame_shape,
        )

        self.assertTrue(result["closeup"])
        self.assertTrue(result["front"])
        self.assertGreaterEqual(result["closeupScore"], 0.7)
        self.assertGreaterEqual(result["frontScore"], 0.72)
        self.assertAlmostEqual(result["faceWidthRatio"], 0.3125, places=4)
        self.assertAlmostEqual(result["faceHeightRatio"], 520 / 1080, places=4)
        self.assertAlmostEqual(result["faceAreaRatio"], 600 * 520 / (1920 * 1080), places=4)

    def test_extreme_closeup_uses_face_area_and_not_low_head_geometry(self):
        result = evaluate_cute_face(
            {"x": 400, "y": 150, "width": 1100, "height": 800},
            catflw_landmarks(),
            self.frame_shape,
            model_confidence=0.9,
        )

        self.assertTrue(result["extremeCloseup"])
        self.assertGreaterEqual(result["extremeCloseupScore"], 0.80)
        self.assertGreater(result["cuteScore"], 0.80)
        self.assertIn("extreme_closeup", result["cuteReasons"])
        self.assertEqual(result["faceRelation"], "toward_camera")

    def test_small_face_is_not_a_closeup(self):
        result = evaluate_cute_face(
            {"x": 850, "y": 380, "width": 220, "height": 240},
            catflw_landmarks(left_eye=(900, 430), right_eye=(1020, 430), muzzle=(960, 530)),
            self.frame_shape,
        )

        self.assertFalse(result["closeup"])
        self.assertFalse(result["front"])
        self.assertLess(result["closeupScore"], 0.7)

    def test_asymmetric_profile_face_is_not_front_facing(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(left_eye=(730, 390), right_eye=(870, 410), muzzle=(1110, 610)),
            self.frame_shape,
        )

        self.assertTrue(result["closeup"])
        self.assertFalse(result["front"])
        self.assertLess(result["frontScore"], 0.72)

    def test_right_profile_uses_lateral_muzzle_displacement(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(
                left_eye=(760, 390),
                right_eye=(980, 400),
                muzzle=(1110, 590),
            ),
            self.frame_shape,
        )

        self.assertTrue(result["closeup"])
        self.assertFalse(result["front"])
        self.assertTrue(result["profile"])
        self.assertEqual(result["profileSide"], "right")
        self.assertGreaterEqual(result["profileScore"], 0.72)

    def test_left_profile_uses_lateral_muzzle_displacement(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(
                left_eye=(940, 400),
                right_eye=(1160, 390),
                muzzle=(810, 590),
            ),
            self.frame_shape,
        )

        self.assertTrue(result["profile"])
        self.assertEqual(result["profileSide"], "left")

    def test_front_face_is_not_a_profile(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(),
            self.frame_shape,
        )

        self.assertTrue(result["front"])
        self.assertFalse(result["profile"])
        self.assertEqual(result["profileSide"], "")

    def test_raised_muzzle_is_head_up(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(muzzle=(960, 480)),
            self.frame_shape,
        )

        self.assertTrue(result["headUp"])
        self.assertGreaterEqual(result["headUpScore"], 0.72)

    def test_normal_muzzle_height_is_not_head_up(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(),
            self.frame_shape,
        )

        self.assertFalse(result["headUp"])

    def test_low_head_pose_is_not_a_profile(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(
                left_eye=(760, 390),
                right_eye=(980, 400),
                muzzle=(1110, 850),
            ),
            self.frame_shape,
        )

        self.assertFalse(result["profile"])
        self.assertEqual(result["profileSide"], "")
        self.assertFalse(result["extremeCloseup"])
        self.assertLess(result["extremeCloseupScore"], 0.80)

    def test_cute_score_uses_explainable_weighted_components(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(
                left_eye=(760, 390),
                right_eye=(980, 400),
                muzzle=(1110, 590),
            ),
            self.frame_shape,
            model_confidence=0.9,
        )

        self.assertLess(result["cuteScore"], result["profileScore"])
        self.assertAlmostEqual(
            result["cuteScore"],
            round(
                0.40 * result["sizeScore"]
                + 0.30 * result["cameraScore"]
                + 0.20 * result["pitchScore"]
                + 0.10 * result["visibilityScore"],
                4,
            ),
        )
        self.assertEqual(result["faceRelation"], "profile_right")
        self.assertTrue(result["strictEligible"])

    def test_cute_score_requires_reliable_model_confidence(self):
        landmarks = catflw_landmarks()
        reliable = evaluate_cute_face(
            {"x": 400, "y": 150, "width": 1100, "height": 800},
            landmarks,
            self.frame_shape,
            model_confidence=0.65,
        )
        unreliable = evaluate_cute_face(
            {"x": 400, "y": 150, "width": 1100, "height": 800},
            landmarks,
            self.frame_shape,
            model_confidence=0.6,
        )

        self.assertTrue(reliable["cuteEligible"])
        self.assertFalse(unreliable["cuteEligible"])

    def test_valid_landmarks_can_use_the_extreme_closeup_reliability_fallback(self):
        result = evaluate_cute_face(
            {"x": 400, "y": 150, "width": 1100, "height": 800},
            catflw_landmarks(),
            self.frame_shape,
            landmark_fallback_confidence=True,
        )

        self.assertEqual(result["modelConfidence"], 0.65)
        self.assertTrue(result["cuteEligible"])

    def test_malformed_landmarks_keep_closeup_but_not_front(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            [[1.0, 2.0]],
            self.frame_shape,
        )

        self.assertTrue(result["closeup"])
        self.assertFalse(result["front"])
        self.assertEqual(result["frontScore"], 0.0)

    def test_invalid_frame_shape_returns_empty_evidence(self):
        result = evaluate_cute_face(
            {"x": 0, "y": 0, "width": 600, "height": 520},
            catflw_landmarks(),
            (),
        )

        self.assertFalse(result["closeup"])
        self.assertEqual(result["cuteScore"], 0.0)
        self.assertEqual(result["faceRelation"], "unknown")
        self.assertFalse(result["strictEligible"])

    def test_low_head_and_away_face_are_not_cute_candidates(self):
        result = evaluate_cute_face(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            catflw_landmarks(left_eye=(760, 390), right_eye=(980, 400), muzzle=(1110, 850)),
            self.frame_shape,
            model_confidence=0.9,
        )
        self.assertEqual(result["faceRelation"], "head_down")
        self.assertEqual(result["cuteScore"], 0.0)
        self.assertFalse(result["strictEligible"])
        self.assertFalse(result["looseEligible"])

    def test_partial_face_is_explicitly_rejected(self):
        result = evaluate_cute_face(
            {"x": 0, "y": 0, "width": 600, "height": 520},
            catflw_landmarks(left_eye=(80, 90), right_eye=(400, 90), muzzle=(-120, 300)),
            self.frame_shape,
            model_confidence=0.9,
        )
        self.assertEqual(result["faceRelation"], "partial")
        self.assertEqual(result["cuteScore"], 0.0)
        self.assertFalse(result["strictEligible"])

    def test_temporal_smoothing_replaces_one_sample_relation_spike(self):
        frames = [
            {"offsetSec": 0.0, "cuteEvidence": {"faceRelation": "toward_camera", "cuteScore": 0.8}},
            {"offsetSec": 0.5, "cuteEvidence": {"faceRelation": "looking_away", "cuteScore": 0.8}},
            {"offsetSec": 1.0, "cuteEvidence": {"faceRelation": "toward_camera", "cuteScore": 0.8}},
        ]
        smooth_cute_frames(frames)
        self.assertEqual(
            [item["cuteEvidence"]["faceRelation"] for item in frames],
            ["toward_camera", "toward_camera", "toward_camera"],
        )


if __name__ == "__main__":
    unittest.main()
