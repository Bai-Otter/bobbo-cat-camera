from copy import deepcopy

import pytest

from mukbang import daily_outputs, media


def test_story_event_times_map_to_original_speed_concatenation():
    clips = [{"id": "s01", "start": 3., "end": 5., "output_start": 0.,
              "source_first_frame_index": 30, "source_end_frame_index_exclusive": 50},
             {"id": "s02", "start": 8., "end": 11., "output_start": 2.,
              "source_first_frame_index": 80, "source_end_frame_index_exclusive": 110}]
    frames = [{"id": "F0009", "time": 8., "source_frame_index": 80}]
    events = [{"id": "r", "clip_id": "s02", "start": 8., "end": 9.5,
               "frame_ids": ["F0009"], "source_times": [{"frame_id": "F0009", "time": 8.}]}]
    before = deepcopy(events)
    mapped = daily_outputs.map_story_events(events, clips, frames)
    assert mapped[0]["output_start"] == 2.
    assert mapped[0]["output_end"] == 3.5
    assert mapped[0]["source_start"] == 8.
    assert events == before


def test_quantization_cannot_drop_any_story_event_evidence():
    clips = [{"id": "s01", "start": .1, "end": 1., "output_start": 0.,
              "source_first_frame_index": 1, "source_end_frame_index_exclusive": 10}]
    frames = [{"id": "F0001", "time": 0., "source_frame_index": 0}]
    with pytest.raises(ValueError, match="证据"):
        daily_outputs.map_story_events(
            [{"id": "a", "clip_id": "s01", "start": 0., "end": .5, "frame_ids": ["F0001"]}], clips, frames)


def test_story_quantization_never_extends_same_frame_approved_bounds():
    info = {"time_base": "1/10", "origin_pts": 0, "end_pts": 40, "pts": list(range(40))}
    decision = {"clips": [{"id": "s01", "start": .05, "end": 1.05, "frame_ids": ["F0002"],
                            "co_visible_frame_ids": ["F0002"]}], "events": []}
    frames = [{"id": "F0002", "time": .5, "source_frame_index": 5}]
    clips, _, audit = daily_outputs.quantize_story(decision, info, frames)
    assert clips[0]["start"] == .1
    assert clips[0]["end"] == 1.
    assert clips[0]["end"] <= decision["clips"][0]["end"]
    assert audit[0]["type"] == "story_inward_frame_quantization"


def test_real_poster_is_a_frame_inside_its_actual_final_clip():
    sampling = {"frames": [{"id": "a", "time": 1., "url": "/a.jpg", "score": 99},
                            {"id": "b", "time": 3., "url": "/b.jpg", "score": 80}]}
    assert daily_outputs.poster_url(sampling, [{"start": 2., "end": 4., "frame_ids": ["b"]}]) == "/b.jpg"
    assert daily_outputs.poster_url(sampling, []) is None


def test_story_tiny_boundary_deltas_do_not_weaken_inward_cuts():
    info = {"time_base": "1/10", "origin_pts": 0, "end_pts": 40, "pts": list(range(40))}
    decision = {"clips": [{"id": "s01", "start": .100000005, "end": 1.09999995,
                           "frame_ids": ["f"], "co_visible_frame_ids": ["f"]}], "events": []}
    clips, _, _ = daily_outputs.quantize_story(decision, info, [{"id": "f", "time": .5, "source_frame_index": 5}])
    assert clips[0]["start"] == .2
    assert clips[0]["end"] == 1.


def test_event_reference_must_be_inside_event_not_just_parent_clip():
    clip = {"id": "s", "start": 0., "end": 4., "output_start": 0.,
            "source_first_frame_index": 0, "source_end_frame_index_exclusive": 40}
    with pytest.raises(ValueError, match="事件区间"):
        daily_outputs.map_story_events([{"id": "e", "clip_id": "s", "start": 0., "end": 1., "frame_ids": ["f"]}],
                                       [clip], [{"id": "f", "time": 2., "source_frame_index": 20}])
