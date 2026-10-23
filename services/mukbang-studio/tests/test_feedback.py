"""Human-feedback validation and comparison: no model, media, or credentials."""
from copy import deepcopy

from pydantic import ValidationError
import pytest

from mukbang.feedback import (
    FeedbackDraftUpdate,
    FrameAnnotation,
    build_comparison,
    validate_annotations,
)


def annotation(frame_id="F0001", label="like", reason=""):
    return {"frame_id": frame_id, "label": label, "reason": reason}


def test_frame_annotation_defaults_and_boundary_ids():
    assert FrameAnnotation(frame_id="F0001", label="like").model_dump() == annotation()
    assert FrameAnnotation(frame_id="F123456", label="dislike").label == "dislike"
    assert FrameAnnotation(frame_id="F12345", label="like").frame_id == "F12345"


@pytest.mark.parametrize("frame_id", [
    "F123", "F1234567", "f0001", " F0001", "F0001 ", "F0001\n",
    "F１２３４", "../F0001", "F00A1", "", None, 1234,
])
def test_frame_annotation_rejects_invalid_ids(frame_id):
    with pytest.raises(ValidationError):
        FrameAnnotation(frame_id=frame_id, label="like")


@pytest.mark.parametrize("label", ["neutral", "liked", "Like", "", None, ["like"]])
def test_only_explicit_like_dislike_are_labels(label):
    with pytest.raises(ValidationError):
        FrameAnnotation(frame_id="F0001", label=label)


def test_reason_preserves_human_text_and_has_a_hard_limit():
    reason = "  眼神好可爱，不喜欢遮脸。\n" * 10
    assert FrameAnnotation(frame_id="F0001", label="like", reason=reason).reason == reason
    assert len(FrameAnnotation(frame_id="F0001", label="like", reason="猫" * 500).reason) == 500
    with pytest.raises(ValidationError):
        FrameAnnotation(frame_id="F0001", label="like", reason="猫" * 501)
    with pytest.raises(ValidationError):
        FrameAnnotation(frame_id="F0001", label="like", reason=None)


def test_extra_fields_forbidden_in_both_models():
    with pytest.raises(ValidationError):
        FrameAnnotation(frame_id="F0001", label="like", score=100)
    with pytest.raises(ValidationError):
        FeedbackDraftUpdate(expected_version=0, train_model=True)


def test_draft_defaults_are_independent_and_zero_version_valid():
    first = FeedbackDraftUpdate(expected_version=0)
    second = FeedbackDraftUpdate(expected_version=1)
    assert first.model_dump() == {"expected_version": 0, "annotations": [], "note": ""}
    first.annotations.append(FrameAnnotation(frame_id="F0001", label="like"))
    assert second.annotations == []


@pytest.mark.parametrize("version", [-1, True, False, 0.0, 1.0, "0", None])
def test_draft_version_is_nonnegative_strict_integer(version):
    with pytest.raises(ValidationError):
        FeedbackDraftUpdate(expected_version=version)


def test_expected_version_is_required():
    with pytest.raises(ValidationError):
        FeedbackDraftUpdate()


def test_draft_annotation_and_note_limits():
    annotations = [annotation(f"F{i:04}") for i in range(2400)]
    draft = FeedbackDraftUpdate(expected_version=0, annotations=annotations, note="猫" * 4000)
    assert len(draft.annotations) == 2400
    with pytest.raises(ValidationError):
        FeedbackDraftUpdate(expected_version=0, annotations=annotations + [annotation("F2400")])
    with pytest.raises(ValidationError):
        FeedbackDraftUpdate(expected_version=0, note="猫" * 4001)


def test_known_annotation_ids_and_neutral_unmarked_frames():
    frames = [{"id": "F0001", "time": 0}, {"id": "F0002", "time": 1}, {"id": "F0003", "time": 2}]
    annotations = [annotation("F0001", "like"), annotation("F0003", "dislike")]
    before = deepcopy((annotations, frames))
    assert validate_annotations(annotations, frames) is None
    assert validate_annotations([], frames) is None
    assert validate_annotations([], []) is None
    assert (annotations, frames) == before


@pytest.mark.parametrize("second_label", ["like", "dislike"])
def test_duplicate_same_or_conflicting_annotations_rejected(second_label):
    with pytest.raises(ValueError, match="重复"):
        validate_annotations([annotation("F0001"), annotation("F0001", second_label)], [{"id": "F0001"}])


def test_unknown_or_other_video_id_rejected_without_echoing_text():
    sensitive = "private-value-should-not-be-echoed"
    with pytest.raises(ValueError) as caught:
        validate_annotations([annotation(sensitive, reason=sensitive)], [{"id": "F0001"}])
    assert sensitive not in str(caught.value)
    with pytest.raises(ValueError):
        validate_annotations([annotation("F0002")], [{"id": "F0001"}])


@pytest.mark.parametrize("annotations", [None, {}, "F0001", [None], [["F0001"]], [{"frame_id": []}], [{"label": "like"}]])
def test_validate_annotations_bad_shape_raises_fixed_value_error(annotations):
    with pytest.raises(ValueError):
        validate_annotations(annotations, [{"id": "F0001"}])


def test_comparison_changes_and_feedback_coverage_exactly():
    previous = [{"id": "F0001"}, {"frame_id": "F0002"}, {"id": "F0004"}]
    parsed = {"selected_frames": [{"frame_id": "F0002"}, {"frame_id": "F0003"}, {"frame_id": "F0005"}]}
    feedback = {"version": 7, "note": "只用于当前视频", "annotations": [
        annotation("F0002", "like"), annotation("F0006", "like"),
        annotation("F0001", "dislike"), annotation("F0003", "dislike"),
        annotation("F0007", "dislike"),
    ]}
    before = deepcopy((previous, parsed, feedback))
    assert build_comparison("parent123", previous, parsed, feedback) == {
        "parent_job_id": "parent123",
        "added_frame_ids": ["F0003", "F0005"],
        "removed_frame_ids": ["F0001", "F0004"],
        "kept_frame_ids": ["F0002"],
        "liked_selected_ids": ["F0002"],
        "liked_omitted_ids": ["F0006"],
        "disliked_selected_ids": ["F0003"],
        # F0007 was not previously selected: it still counts as not selected now.
        "disliked_removed_ids": ["F0001", "F0007"],
    }
    assert (previous, parsed, feedback) == before


def test_comparison_is_stable_and_deduplicated():
    previous = [{"id": "F0009"}, {"frame_id": "F0002"}, {"id": "F0009"}]
    current = [{"frame_id": "F0009"}, {"frame_id": "F0003"}, {"frame_id": "F0001"}, {"frame_id": "F0003"}]
    result = build_comparison("p", previous, {"selected_frames": current}, {"annotations": []})
    assert result["added_frame_ids"] == ["F0001", "F0003"]
    assert result["removed_frame_ids"] == ["F0002"]
    assert result["kept_frame_ids"] == ["F0009"]
    assert all(value == sorted(set(value)) for key, value in result.items() if key != "parent_job_id")
    assert not any("accuracy" in key or "score" in key for key in result)


@pytest.mark.parametrize("parsed", [None, [], 1, "invalid", {}, {"selected_frames": None}, {"selected_frames": {}},
    {"selected_frames": [None, [], {"frame_id": []}, {"frame_id": {}}, {"frame_id": 3}]}])
def test_bad_model_structure_is_safe_for_pre_validation_comparison(parsed):
    result = build_comparison("p", [{"id": "F0001"}], parsed, {"annotations": [annotation("F0002", "like")]})
    assert result["added_frame_ids"] == []
    assert result["removed_frame_ids"] == ["F0001"]
    assert result["liked_omitted_ids"] == ["F0002"]


def test_comparison_ignores_bad_rows_and_retains_valid_raw_model_evidence():
    parsed = {"selected_frames": [None, {"frame_id": []}, {"frame_id": "F0002"}, {"id": "F0003"}, {"frame_id": "not-an-id"}]}
    result = build_comparison("p", [{"id": "F0001"}, None, {"id": []}], parsed, {"annotations": []})
    assert result["added_frame_ids"] == ["F0002"]
    assert result["removed_frame_ids"] == ["F0001"]


@pytest.mark.parametrize("feedback", [None, [], 2, {"annotations": None}, {"annotations": {}},
    {"annotations": [None, [], {"frame_id": []}, {"frame_id": "F0001", "label": {}},
                     {"frame_id": "F0001", "label": "neutral"}]}])
def test_malformed_feedback_never_raises_type_error(feedback):
    result = build_comparison("p", [], {"selected_frames": []}, feedback)
    assert result["liked_selected_ids"] == result["liked_omitted_ids"] == []
    assert result["disliked_selected_ids"] == result["disliked_removed_ids"] == []


def test_empty_snapshot_does_not_merge_ancestor_feedback():
    result = build_comparison("p", [{"id": "F0001"}], {"selected_frames": [{"frame_id": "F0001"}]}, {"annotations": [], "note": ""})
    assert result["kept_frame_ids"] == ["F0001"]
    assert result["liked_selected_ids"] == result["liked_omitted_ids"] == []
    assert result["disliked_selected_ids"] == result["disliked_removed_ids"] == []
