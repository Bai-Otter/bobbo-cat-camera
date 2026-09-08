import unittest
from unittest.mock import patch

import numpy as np

from src.feeding_behavior import (
    expand_candidate_timeline,
    classify_average_cat_scale,
    classify_cat_scale,
    expand_bowl_camera_contact_roi,
    evaluate_face_contact,
    evaluate_face_landmark_contact,
    evaluate_mask_contact,
    evaluate_pose_evidence,
    evaluate_pose_evidence_for_frame,
    evaluate_muzzle_motion,
    is_bowl_camera_partial_cat,
    is_bowl_camera_feeding_face,
    is_near_field_cat,
    summarize_behavior_second,
    verify_candidate_behavior,
)


def animal_pose(
    left_eye=(40, 30),
    right_eye=(60, 30),
    nose=(50, 52),
    neck=(50, 72),
    confidence=0.9,
):
    keypoints = np.zeros((17, 2), dtype=np.float32)
    scores = np.zeros(17, dtype=np.float32)
    for index, point in ((0, left_eye), (1, right_eye), (2, nose), (3, neck)):
        keypoints[index] = point
        scores[index] = confidence
    return keypoints, scores


class PoseEvidenceTests(unittest.TestCase):
    def test_accepts_reliable_muzzle_pointing_into_bowl(self):
        keypoints, scores = animal_pose()

        evidence = evaluate_pose_evidence(
            keypoints,
            scores,
            bowl_roi={"x": 35, "y": 45, "width": 30, "height": 30},
        )

        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["muzzleSource"], "nose")
        self.assertGreaterEqual(evidence["confidence"], 0.8)

    def test_rejects_low_confidence_nose_without_reliable_head_axis(self):
        keypoints, scores = animal_pose(confidence=0.2)

        evidence = evaluate_pose_evidence(
            keypoints,
            scores,
            bowl_roi={"x": 35, "y": 45, "width": 30, "height": 30},
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "HEAD_KEYPOINTS_UNRELIABLE")

    def test_rejects_reliable_head_that_is_not_near_bowl(self):
        keypoints, scores = animal_pose()

        evidence = evaluate_pose_evidence(
            keypoints,
            scores,
            bowl_roi={"x": 200, "y": 200, "width": 30, "height": 30},
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "MUZZLE_AWAY_FROM_BOWL")


class FaceContactEvidenceTests(unittest.TestCase):
    @staticmethod
    def cat_face_landmarks(mouth_y=76):
        landmarks = [[50.0, 50.0] for _ in range(48)]
        landmarks[4] = [35.0, 35.0]
        landmarks[8] = [65.0, 35.0]
        landmarks[16] = [50.0, mouth_y - 3]
        landmarks[17] = [50.0, mouth_y + 3]
        landmarks[46] = [42.0, mouth_y]
        landmarks[47] = [58.0, mouth_y]
        return landmarks

    def test_accepts_face_box_touching_food_roi(self):
        evidence = evaluate_face_contact(
            face_box={"x": 300, "y": 100, "width": 198, "height": 220},
            bowl_roi={"x": 500, "y": 0, "width": 100, "height": 400},
        )

        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["evidenceMode"], "face-contact")
        self.assertEqual(evidence["faceDistance"], 2.0)

    def test_rejects_face_box_with_visible_gap_to_food(self):
        evidence = evaluate_face_contact(
            face_box={"x": 200, "y": 100, "width": 180, "height": 220},
            bowl_roi={"x": 500, "y": 0, "width": 100, "height": 400},
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "FACE_AWAY_FROM_BOWL")

    def test_accepts_catflw_mouth_landmarks_touching_food(self):
        evidence = evaluate_face_landmark_contact(
            face_box={"x": 20, "y": 10, "width": 60, "height": 80},
            landmarks=self.cat_face_landmarks(mouth_y=76),
            bowl_roi={"x": 20, "y": 75, "width": 60, "height": 25},
        )

        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["evidenceMode"], "face-landmark-contact")
        self.assertEqual(evidence["muzzleSource"], "catflw-mouth")

    def test_rejects_catflw_mouth_landmarks_above_food(self):
        evidence = evaluate_face_landmark_contact(
            face_box={"x": 20, "y": 10, "width": 60, "height": 80},
            landmarks=self.cat_face_landmarks(mouth_y=45),
            bowl_roi={"x": 20, "y": 75, "width": 60, "height": 25},
        )

        self.assertFalse(evidence["verified"])
        self.assertTrue(evidence["faceObserved"])
        self.assertEqual(evidence["reason"], "FACE_MOUTH_AWAY_FROM_BOWL")

    def test_scales_catflw_contact_distance_from_eye_spacing_for_large_faces(self):
        landmarks = self.cat_face_landmarks(mouth_y=300)
        landmarks[4] = [200.0, 120.0]
        landmarks[8] = [300.0, 120.0]
        landmarks[16] = [250.0, 294.0]
        landmarks[17] = [250.0, 306.0]
        landmarks[46] = [230.0, 300.0]
        landmarks[47] = [270.0, 300.0]

        evidence = evaluate_face_landmark_contact(
            face_box={"x": 100, "y": 40, "width": 300, "height": 300},
            landmarks=landmarks,
            bowl_roi={"x": 100, "y": 350, "width": 500, "height": 200},
        )

        self.assertTrue(evidence["verified"])
        self.assertGreaterEqual(evidence["contactThreshold"], 50)


class NearFieldCatTests(unittest.TestCase):
    def test_classifies_reference_feeding_average_as_near(self):
        boxes = [
            {"x": 0, "y": 0, "width": 436, "height": 379},
            {"x": 0, "y": 0, "width": 401, "height": 363},
            {"x": 0, "y": 0, "width": 451, "height": 390},
        ]

        self.assertEqual(classify_average_cat_scale(boxes, (544, 960, 3)), "near")

    def test_classifies_old_false_positive_average_as_distant(self):
        boxes = [
            {"x": 0, "y": 0, "width": 133, "height": 484},
            {"x": 0, "y": 0, "width": 145, "height": 499},
            {"x": 0, "y": 0, "width": 122, "height": 468},
        ]

        self.assertEqual(classify_average_cat_scale(boxes, (544, 960, 3)), "distant")

    def test_accepts_large_head_dominant_cat_without_requiring_full_frame_coverage(self):
        self.assertTrue(
            is_near_field_cat(
                {"x": 250, "y": 90, "width": 430, "height": 360, "confidence": 0.8},
                frame_shape=(544, 960, 3),
            )
        )

    def test_rejects_small_distant_cat(self):
        self.assertFalse(
            is_near_field_cat(
                {"x": 700, "y": 250, "width": 120, "height": 140, "confidence": 0.8},
                frame_shape=(544, 960, 3),
            )
        )

    def test_rejects_distant_profile_even_when_it_has_enough_pixels_for_landmarks(self):
        box = {"x": 1163, "y": 815, "width": 180, "height": 263, "confidence": 0.75}

        self.assertEqual(classify_cat_scale(box, (1080, 1920, 3)), "distant")
        self.assertFalse(is_near_field_cat(box, frame_shape=(1080, 1920, 3)))

    def test_classifies_intermediate_cat_by_full_frame_ratio(self):
        self.assertEqual(
            classify_cat_scale(
                {"x": 1000, "y": 300, "width": 650, "height": 650, "confidence": 0.8},
                (1080, 1920, 3),
            ),
            "intermediate",
        )

    def test_classifies_near_cat_by_full_frame_ratio(self):
        self.assertEqual(
            classify_cat_scale(
                {"x": 850, "y": 180, "width": 900, "height": 800, "confidence": 0.8},
                (1080, 1920, 3),
            ),
            "near",
        )

    def test_recognizes_wide_edge_clipped_cat_touching_bowl_camera_roi(self):
        self.assertTrue(
            is_bowl_camera_partial_cat(
                {"x": 430, "y": 1300, "width": 1007, "height": 265},
                {"x": 1126, "y": 1541, "width": 259, "height": 259},
                (2560, 1440, 3),
            )
        )

    def test_does_not_promote_wide_strip_away_from_bowl_or_frame_edge(self):
        bowl_roi = {"x": 1126, "y": 1541, "width": 259, "height": 259}
        self.assertFalse(
            is_bowl_camera_partial_cat(
                {"x": 300, "y": 700, "width": 800, "height": 300},
                bowl_roi,
                (2560, 1440, 3),
            )
        )
        self.assertFalse(
            is_bowl_camera_partial_cat(
                {"x": 600, "y": 1300, "width": 700, "height": 300},
                bowl_roi,
                (2560, 1440, 3),
            )
        )

    def test_expands_food_patch_to_bowl_camera_contact_band(self):
        expanded = expand_bowl_camera_contact_roi(
            {"x": 1126, "y": 1541, "width": 259, "height": 259},
            [{"x": 430, "y": 1300, "width": 1007, "height": 265}],
            (2560, 1440, 3),
        )

        self.assertEqual(expanded["x"], 0)
        self.assertEqual(expanded["width"], 1440)
        self.assertLessEqual(expanded["y"], 1360)
        self.assertGreaterEqual(expanded["height"], 640)

    def test_accepts_pixel_rich_face_only_for_bowl_camera_rule(self):
        face = {"x": 650, "y": 1200, "width": 250, "height": 210}

        self.assertTrue(is_bowl_camera_feeding_face(face, (2560, 1440, 3)))


class MaskContactEvidenceTests(unittest.TestCase):
    def test_accepts_cat_mask_covering_food_roi(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[10:90, 85:100] = 1

        evidence = evaluate_mask_contact(
            mask,
            bowl_roi={"x": 80, "y": 0, "width": 20, "height": 100},
            detector_confidence=0.6,
        )

        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["evidenceMode"], "mask-contact")
        self.assertGreater(evidence["maskContactRatio"], 0.5)

    def test_rejects_cat_mask_outside_food_roi(self):
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[10:90, 10:60] = 1

        evidence = evaluate_mask_contact(
            mask,
            bowl_roi={"x": 80, "y": 0, "width": 20, "height": 100},
            detector_confidence=0.8,
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "CAT_MASK_AWAY_FROM_BOWL")

    def test_large_bowl_roi_does_not_expand_contact_distance_without_bound(self):
        keypoints, scores = animal_pose()

        evidence = evaluate_pose_evidence(
            keypoints,
            scores,
            bowl_roi={"x": 0, "y": 200, "width": 1000, "height": 1000},
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "MUZZLE_AWAY_FROM_BOWL")

    def test_accepts_reliable_eyes_and_nose_when_neck_is_occluded(self):
        keypoints, scores = animal_pose()
        scores[3] = 0.2

        evidence = evaluate_pose_evidence(
            keypoints,
            scores,
            bowl_roi={"x": 35, "y": 45, "width": 30, "height": 30},
        )

        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["muzzleSource"], "nose")

    def test_accepts_lower_confidence_contact_only_for_extreme_closeup(self):
        keypoints, scores = animal_pose(confidence=0.3)

        evidence = evaluate_pose_evidence_for_frame(
            keypoints,
            scores,
            bowl_roi={"x": 45, "y": 45, "width": 30, "height": 30},
            cat_box={"x": 1, "y": 1, "width": 118, "height": 118},
            frame_shape=(120, 120, 3),
        )

        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["evidenceMode"], "closeup")

    def test_rejects_lower_confidence_pose_when_cat_does_not_fill_frame(self):
        keypoints, scores = animal_pose(confidence=0.3)

        evidence = evaluate_pose_evidence_for_frame(
            keypoints,
            scores,
            bowl_roi={"x": 45, "y": 45, "width": 30, "height": 30},
            cat_box={"x": 10, "y": 10, "width": 80, "height": 80},
            frame_shape=(120, 120, 3),
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "HEAD_KEYPOINTS_UNRELIABLE")

    def test_rejects_extreme_closeup_when_low_confidence_nose_is_away_from_food(self):
        keypoints, scores = animal_pose(confidence=0.3)

        evidence = evaluate_pose_evidence_for_frame(
            keypoints,
            scores,
            bowl_roi={"x": 100, "y": 100, "width": 20, "height": 20},
            cat_box={"x": 1, "y": 1, "width": 118, "height": 118},
            frame_shape=(120, 120, 3),
        )

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "MUZZLE_AWAY_FROM_BOWL")


class MuzzleMotionTests(unittest.TestCase):
    @staticmethod
    def base_crop():
        y, x = np.mgrid[:64, :64]
        return ((x * 2 + y * 3) % 255).astype(np.uint8)

    def test_rejects_static_muzzle_crops(self):
        crop = self.base_crop()

        evidence = evaluate_muzzle_motion([crop.copy() for _ in range(12)], fps=8)

        self.assertFalse(evidence["verified"])
        self.assertEqual(evidence["reason"], "MUZZLE_STATIC")

    def test_rejects_whole_crop_translation(self):
        crop = self.base_crop()
        translated = [np.roll(crop, shift=index % 3, axis=1) for index in range(12)]

        evidence = evaluate_muzzle_motion(translated, fps=8)

        self.assertFalse(evidence["verified"])

    def test_accepts_sustained_local_muzzle_motion(self):
        crop = self.base_crop()
        frames = []
        for index in range(16):
            frame = crop.copy()
            value = 230 if index % 2 else 25
            frame[26:38, 26:38] = value
            frames.append(frame)

        evidence = evaluate_muzzle_motion(frames, fps=8)

        self.assertTrue(evidence["verified"])
        self.assertGreater(evidence["activeRatio"], 0.5)

    def test_accepts_brief_strong_muzzle_motion(self):
        crop = self.base_crop()
        frames = [crop.copy() for _ in range(12)]
        frames[5][26:38, 26:38] = 230

        evidence = evaluate_muzzle_motion(frames, fps=8)

        self.assertTrue(evidence["verified"])
        self.assertGreaterEqual(evidence["activeRatio"], 0.1)


class BehaviorFusionTests(unittest.TestCase):
    def test_requires_both_pose_and_muzzle_motion(self):
        pose = {"verified": True, "confidence": 0.8, "reason": ""}
        static_motion = {
            "verified": False,
            "score": 0.0,
            "activeRatio": 0.0,
            "sampleCount": 8,
            "reason": "MUZZLE_STATIC",
        }

        evidence = summarize_behavior_second([pose, pose], static_motion)

        self.assertFalse(evidence["eatingVerified"])
        self.assertEqual(evidence["reason"], "MUZZLE_STATIC")

    def test_accepts_joint_sustained_evidence(self):
        pose = {"verified": True, "confidence": 0.8, "reason": ""}
        motion = {
            "verified": True,
            "score": 0.12,
            "activeRatio": 0.75,
            "sampleCount": 8,
            "reason": "",
        }

        evidence = summarize_behavior_second([pose, pose], motion)

        self.assertTrue(evidence["eatingVerified"])
        self.assertGreater(evidence["confidence"], 0.7)

    def test_rejects_direct_face_contact_when_muzzle_motion_is_static(self):
        contact = {
            "verified": True,
            "confidence": 0.7,
            "evidenceMode": "face-contact",
            "reason": "",
        }
        static_motion = {
            "verified": False,
            "score": 0.0,
            "activeRatio": 0.0,
            "sampleCount": 8,
            "reason": "MUZZLE_STATIC",
        }

        evidence = summarize_behavior_second([contact, contact], static_motion)

        self.assertFalse(evidence["eatingVerified"])
        self.assertEqual(evidence["reason"], "MUZZLE_STATIC")

    def test_accepts_static_face_contact_only_for_bowl_camera_mode(self):
        contact = {
            "verified": True,
            "confidence": 0.7,
            "evidenceMode": "face-landmark-contact",
            "faceObserved": True,
            "reason": "",
        }
        static_motion = {
            "verified": False,
            "score": 0.0,
            "activeRatio": 0.0,
            "sampleCount": 8,
            "reason": "MUZZLE_STATIC",
        }

        evidence = summarize_behavior_second(
            [contact],
            static_motion,
            allow_static_face_contact=True,
        )

        self.assertTrue(evidence["eatingVerified"])
        self.assertEqual(evidence["verificationMode"], "bowl-camera-face-contact")
        self.assertGreater(evidence["confidence"], 0.5)

    def test_rejects_direct_mask_contact_when_muzzle_motion_is_static(self):
        contact = {
            "verified": True,
            "confidence": 0.75,
            "evidenceMode": "mask-contact",
            "reason": "",
        }
        static_motion = {
            "verified": False,
            "score": 0.0,
            "activeRatio": 0.0,
            "sampleCount": 8,
            "reason": "MUZZLE_STATIC",
        }

        evidence = summarize_behavior_second([contact], static_motion)

        self.assertFalse(evidence["eatingVerified"])
        self.assertEqual(evidence["reason"], "MUZZLE_STATIC")

    def test_accepts_direct_face_contact_with_muzzle_motion(self):
        contact = {
            "verified": True,
            "confidence": 0.7,
            "evidenceMode": "face-contact",
            "reason": "",
        }
        motion = {
            "verified": True,
            "score": 0.12,
            "activeRatio": 0.75,
            "sampleCount": 8,
            "reason": "",
        }

        evidence = summarize_behavior_second([contact, contact], motion)

        self.assertTrue(evidence["eatingVerified"])
        self.assertEqual(evidence["verificationMode"], "face-contact")

    def test_rejects_grooming_motion_without_food_contact(self):
        context = {
            "verified": False,
            "confidence": 0.52,
            "evidenceMode": "face-landmark-contact",
            "faceObserved": True,
            "feedingContextVerified": True,
            "reason": "FACE_MOUTH_AWAY_FROM_BOWL",
        }
        motion = {
            "verified": True,
            "score": 0.012,
            "activeRatio": 0.1111,
            "sampleCount": 10,
            "reason": "",
        }

        evidence = summarize_behavior_second([context], motion)

        self.assertFalse(evidence["eatingVerified"])
        self.assertEqual(evidence["reason"], "FACE_MOUTH_AWAY_FROM_BOWL")


class FakeCapture:
    def __init__(self, frames, fps=8):
        self.frames = list(frames)
        self.fps = fps
        self.index = 0

    def isOpened(self):
        return True

    def get(self, _property):
        return self.fps

    def read(self):
        if self.index >= len(self.frames):
            return False, None
        frame = self.frames[self.index]
        self.index += 1
        return True, frame

    def release(self):
        return None


class SizedFakeCapture(FakeCapture):
    def get(self, property_id):
        import cv2

        if property_id == cv2.CAP_PROP_FRAME_WIDTH:
            return 120
        if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
            return 120
        return self.fps


class FullHdFakeCapture(FakeCapture):
    def get(self, property_id):
        import cv2

        if property_id == cv2.CAP_PROP_FRAME_WIDTH:
            return 1920
        if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
            return 1080
        return self.fps


class FakePoseEstimator:
    def estimate(self, _frame, cat_boxes):
        keypoints, scores = animal_pose()
        return [
            {
                "keypoints": keypoints.tolist(),
                "scores": scores.tolist(),
                "catBox": cat_boxes[0],
            }
        ]


class UnreliablePoseEstimator:
    def estimate(self, _frame, cat_boxes):
        if not cat_boxes:
            return []
        keypoints, scores = animal_pose(confidence=0.1)
        return [
            {
                "keypoints": keypoints.tolist(),
                "scores": scores.tolist(),
                "catBox": cat_boxes[0],
            }
        ]


class FakeFaceEstimator:
    def estimate(self, _frame, _cat_boxes):
        return {
            "faceBox": {"x": 30, "y": 20, "width": 64, "height": 80},
            "landmarks": [],
        }


class FullHdFaceEstimator:
    def __init__(self, face_box, landmarks=None):
        self.face_box = face_box
        self.landmarks = landmarks or []
        self.calls = 0

    def estimate(self, _frame, _cat_boxes):
        self.calls += 1
        return {"faceBox": self.face_box, "landmarks": self.landmarks}


class FakeMaskEstimator:
    def estimate_many(self, frames, _bowl_roi):
        return [
            {
                "verified": True,
                "confidence": 0.8,
                "evidenceMode": "mask-contact",
                "maskContactRatio": 0.3,
                "reason": "",
            }
            for _frame in frames
        ]


class CandidateVideoBehaviorTests(unittest.TestCase):
    coarse_frames = [
        {
            "second": 0,
            "nearBowl": True,
            "targetBoxes": [
                {"x": 10, "y": 10, "width": 80, "height": 90, "confidence": 0.9}
            ],
        }
    ]
    bowl_roi = {"x": 35, "y": 45, "width": 30, "height": 30}

    @staticmethod
    def frame(value=None):
        y, x = np.mgrid[:120, :120]
        frame = np.repeat((((x + y) * 2) % 255).astype(np.uint8)[..., None], 3, axis=2)
        if value is not None:
            frame[46:58, 44:56] = value
        return frame

    def test_rejects_static_near_bowl_video(self):
        frames = [self.frame() for _ in range(8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            self.coarse_frames,
            self.bowl_roi,
            pose_estimator=FakePoseEstimator(),
            capture_factory=lambda _source: FakeCapture(frames),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "MUZZLE_STATIC")

    def test_stops_second_pass_after_the_last_sample_window(self):
        capture = FakeCapture([self.frame() for _ in range(80)], fps=8)

        verify_candidate_behavior(
            "long-playlist.m3u8",
            self.coarse_frames,
            self.bowl_roi,
            pose_estimator=FakePoseEstimator(),
            capture_factory=lambda _source: capture,
        )

        self.assertLessEqual(capture.index, 9)

    def test_accepts_local_muzzle_motion_in_candidate_video(self):
        frames = [self.frame(230 if index % 2 else 25) for index in range(8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            self.coarse_frames,
            self.bowl_roi,
            pose_estimator=FakePoseEstimator(),
            capture_factory=lambda _source: FakeCapture(frames),
        )

        self.assertTrue(result[0]["eatingVerified"])
        self.assertGreaterEqual(result[0]["sampleCount"], 8)

    def test_runs_face_verification_before_rejecting_distant_corner_cat(self):
        distant_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 1163, "y": 815, "width": 180, "height": 263, "confidence": 0.75}
                ],
            }
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 1450, "y": 700, "width": 300, "height": 300}
        )

        result = verify_candidate_behavior(
            "clip.mp4",
            distant_frames,
            {"x": 1450, "y": 0, "width": 470, "height": 1080},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "CAT_FACE_TOO_SMALL_FOR_FEEDING")
        self.assertIn("cuteEvidence", result[0])
        self.assertEqual(face_estimator.calls, 1)

    def test_does_not_reject_edge_clipped_bowl_camera_cat_as_distant(self):
        partial_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 520, "y": 600, "width": 1395, "height": 125, "confidence": 0.8}
                ],
            }
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 1250, "y": 540, "width": 520, "height": 400}
        )

        result = verify_candidate_behavior(
            "clip.mp4",
            partial_frames,
            {"x": 1450, "y": 700, "width": 320, "height": 260},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            mask_estimator=FakeMaskEstimator(),
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertGreater(face_estimator.calls, 0)
        self.assertNotEqual(result[0]["reason"], "CAT_TOO_FAR_FOR_FEEDING")

    def test_propagates_closeup_and_front_face_evidence_from_catflw(self):
        near_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 650, "y": 180, "width": 900, "height": 800, "confidence": 0.9}
                ],
            }
        ]
        landmarks = [[960.0, 500.0] for _ in range(48)]
        landmarks[4] = [800.0, 400.0]
        landmarks[8] = [1120.0, 400.0]
        landmarks[16] = [960.0, 602.0]
        landmarks[17] = [960.0, 618.0]
        landmarks[46] = [942.0, 610.0]
        landmarks[47] = [978.0, 610.0]
        face_estimator = FullHdFaceEstimator(
            {"x": 660, "y": 230, "width": 600, "height": 520},
            landmarks=landmarks,
        )
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)

        result = verify_candidate_behavior(
            "clip.mp4",
            near_frames,
            {"x": 900, "y": 600, "width": 200, "height": 200},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertEqual(face_estimator.calls, 1)
        self.assertTrue(result[0]["cuteEvidence"]["closeup"])
        self.assertTrue(result[0]["cuteEvidence"]["front"])
        self.assertGreaterEqual(result[0]["cuteEvidence"]["frontScore"], 0.72)
        self.assertEqual(result[0]["cuteEvidence"]["modelConfidence"], 0.9)
        self.assertIn("cuteScore", result[0]["cuteEvidence"])
        self.assertIsInstance(result[0]["cuteEvidence"]["cuteReasons"], list)

    def test_keeps_cute_evidence_separate_for_half_second_samples(self):
        sampled_frames = [
            {
                "sampleIndex": sample_index,
                "offsetSec": sample_index * 0.5,
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 650, "y": 180, "width": 900, "height": 800, "confidence": 0.9}
                ],
            }
            for sample_index in range(2)
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 660, "y": 230, "width": 600, "height": 520}
        )
        cute_evidence = [
            {"cuteScore": 0.81, "modelConfidence": 0.9, "cuteEligible": True},
            {"cuteScore": 0.93, "modelConfidence": 0.9, "cuteEligible": True},
        ]

        feeding_evidence = {
            "eatingVerified": True,
            "confidence": 0.84,
            "reason": "",
        }
        with patch("src.feeding_behavior.evaluate_cute_face", side_effect=cute_evidence), patch(
            "src.feeding_behavior.summarize_behavior_second",
            return_value=feeding_evidence,
        ) as summarize_feeding:
            result = verify_candidate_behavior(
                "clip.mp4",
                sampled_frames,
                {"x": 900, "y": 600, "width": 200, "height": 200},
                pose_estimator=UnreliablePoseEstimator(),
                face_estimator=face_estimator,
                capture_factory=lambda _source: FullHdFakeCapture([frame] * 2, fps=2),
            )

        self.assertEqual(set(result), {0, 1})
        self.assertEqual(
            [result[sample_index]["cuteEvidence"]["cuteScore"] for sample_index in range(2)],
            [0.81, 0.93],
        )
        self.assertEqual(summarize_feeding.call_count, 1)
        self.assertTrue(all(result[sample_index]["eatingVerified"] for sample_index in range(2)))

    def test_uses_catflw_reliability_fallback_when_whole_cat_box_is_missing(self):
        near_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [],
            }
        ]
        landmarks = [[960.0, 500.0] for _ in range(48)]
        landmarks[4] = [800.0, 400.0]
        landmarks[8] = [1120.0, 400.0]
        landmarks[16] = [960.0, 472.0]
        landmarks[17] = [960.0, 488.0]
        landmarks[46] = [942.0, 480.0]
        landmarks[47] = [978.0, 480.0]
        face_estimator = FullHdFaceEstimator(
            {"x": 400, "y": 150, "width": 1100, "height": 800},
            landmarks=landmarks,
        )
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)

        result = verify_candidate_behavior(
            "clip.mp4",
            near_frames,
            {"x": 900, "y": 600, "width": 200, "height": 200},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertEqual(result[0]["cuteEvidence"]["modelConfidence"], 0.65)
        self.assertTrue(result[0]["cuteEvidence"]["cuteEligible"])

    def test_rejects_face_box_contact_without_landmarks_even_with_motion(self):
        near_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 10, "y": 10, "width": 80, "height": 90, "confidence": 0.9}
                ],
            }
        ]
        frames = [self.frame(230 if index % 2 else 25) for index in range(8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            near_frames,
            self.bowl_roi,
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=FakeFaceEstimator(),
            capture_factory=lambda _source: FakeCapture(frames),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "FACE_LANDMARKS_UNRELIABLE")

    def test_rejects_intermediate_cat_when_detected_face_is_still_small(self):
        intermediate_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 1000, "y": 300, "width": 650, "height": 650, "confidence": 0.8}
                ],
            }
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 1450, "y": 700, "width": 100, "height": 150}
        )

        result = verify_candidate_behavior(
            "clip.mp4",
            intermediate_frames,
            {"x": 1450, "y": 0, "width": 470, "height": 1080},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "CAT_FACE_TOO_SMALL_FOR_FEEDING")
        self.assertGreater(face_estimator.calls, 0)

    def test_rejects_near_cat_when_detected_face_is_still_small(self):
        near_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 850, "y": 180, "width": 900, "height": 800, "confidence": 0.8}
                ],
            }
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 1450, "y": 700, "width": 100, "height": 150}
        )

        result = verify_candidate_behavior(
            "clip.mp4",
            near_frames,
            {"x": 1450, "y": 0, "width": 470, "height": 1080},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "CAT_FACE_TOO_SMALL_FOR_FEEDING")
        self.assertGreater(face_estimator.calls, 0)

    def test_rejects_intermediate_face_that_is_only_four_percent_of_frame(self):
        intermediate_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 1060, "y": 73, "width": 320, "height": 992, "confidence": 0.8}
                ],
            }
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 1081, "y": 82, "width": 271, "height": 339}
        )

        result = verify_candidate_behavior(
            "clip.mp4",
            intermediate_frames,
            {"x": 1330, "y": 0, "width": 590, "height": 1080},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "CAT_FACE_TOO_SMALL_FOR_FEEDING")
        self.assertEqual(face_estimator.calls, 1)

    def test_rejects_intermediate_cat_with_static_face_contact(self):
        intermediate_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 1000, "y": 300, "width": 650, "height": 650, "confidence": 0.8}
                ],
            }
        ]
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        face_estimator = FullHdFaceEstimator(
            {"x": 1300, "y": 450, "width": 520, "height": 400}
        )

        result = verify_candidate_behavior(
            "clip.mp4",
            intermediate_frames,
            {"x": 1700, "y": 0, "width": 220, "height": 1080},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=face_estimator,
            capture_factory=lambda _source: FullHdFakeCapture([frame] * 8),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "FACE_LANDMARKS_UNRELIABLE")

    def test_rejects_sustained_face_contact_without_muzzle_motion(self):
        closeup_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 1, "y": 1, "width": 118, "height": 118, "confidence": 0.9}
                ],
            }
        ]
        frames = [self.frame() for _ in range(8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            closeup_frames,
            {"x": 95, "y": 0, "width": 25, "height": 120},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=FakeFaceEstimator(),
            capture_factory=lambda _source: FakeCapture(frames),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "FACE_LANDMARKS_UNRELIABLE")

    def test_rejects_mask_contact_without_muzzle_motion(self):
        closeup_frames = [
            {
                "second": 0,
                "nearBowl": True,
                "targetBoxes": [
                    {"x": 1, "y": 1, "width": 118, "height": 118, "confidence": 0.9}
                ],
            }
        ]
        frames = [self.frame() for _ in range(8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            closeup_frames,
            {"x": 95, "y": 0, "width": 25, "height": 120},
            pose_estimator=UnreliablePoseEstimator(),
            mask_estimator=FakeMaskEstimator(),
            capture_factory=lambda _source: FakeCapture(frames),
        )

        self.assertFalse(result[0]["eatingVerified"])
        self.assertEqual(result[0]["reason"], "INSUFFICIENT_MUZZLE_SAMPLES")

    def test_tracks_near_field_face_through_coarse_detector_gaps(self):
        sampled_frames = [
            {
                "second": second,
                "nearBowl": second in {0, 4},
                "targetBoxes": (
                    [{"x": 10, "y": 10, "width": 80, "height": 90, "confidence": 0.9}]
                    if second in {0, 4}
                    else []
                ),
            }
            for second in range(5)
        ]
        frames = [self.frame() for _ in range(5 * 8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            sampled_frames,
            {"x": 95, "y": 0, "width": 25, "height": 120},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=FakeFaceEstimator(),
            capture_factory=lambda _source: SizedFakeCapture(frames),
        )

        self.assertEqual(set(result), set(range(5)))

    def test_expands_each_cat_positive_window_without_filling_long_gaps(self):
        sampled_frames = [
            {
                "second": second,
                "hasCat": second in {2, 20},
                "nearBowl": False,
                "targetBoxes": (
                    [{"x": 10, "y": 10, "width": 80, "height": 90, "confidence": 0.9}]
                    if second in {2, 20}
                    else []
                ),
            }
            for second in range(31)
        ]
        frames = [self.frame() for _ in range(31 * 8)]

        result = verify_candidate_behavior(
            "clip.mp4",
            sampled_frames,
            {"x": 25, "y": 80, "width": 50, "height": 40},
            pose_estimator=UnreliablePoseEstimator(),
            face_estimator=FakeFaceEstimator(),
            capture_factory=lambda _source: SizedFakeCapture(frames),
        )

        self.assertEqual(set(result), set(range(0, 9)) | set(range(18, 27)))
        self.assertTrue(all(not result[second]["eatingVerified"] for second in range(5)))

    def test_densifies_sparse_coarse_windows_to_one_slot_per_second(self):
        sampled_frames = [
            {
                "sampleIndex": index,
                "offsetSec": float(second),
                "second": second,
                "hasCat": second in {2, 20},
                "nearBowl": False,
                "targetBoxes": (
                    [{"x": 10, "y": 10, "width": 80, "height": 90, "confidence": 0.9}]
                    if second in {2, 20}
                    else []
                ),
            }
            for index, second in enumerate(range(0, 31, 2))
        ]

        expanded = expand_candidate_timeline(sampled_frames)
        expanded_by_second = {int(frame["second"]): frame for frame in expanded}

        self.assertTrue(set(range(0, 9)).issubset(expanded_by_second))
        self.assertTrue(set(range(18, 27)).issubset(expanded_by_second))
        self.assertNotIn(9, expanded_by_second)
        self.assertNotIn(17, expanded_by_second)
        self.assertTrue(expanded_by_second[1]["coarseInterpolated"])
        self.assertFalse(expanded_by_second[1]["hasCat"])
        self.assertTrue(expanded_by_second[1]["targetBoxes"])
        self.assertEqual(
            len({int(frame["sampleIndex"]) for frame in expanded}),
            len(expanded),
        )


if __name__ == "__main__":
    unittest.main()
