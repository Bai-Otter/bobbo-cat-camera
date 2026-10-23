"""Self-contained historical-import tests: no real media, model, or network.

The video fixture is an opaque byte-copy sentinel, not a decodable MP4. The
importer never interprets video; these tests verify that it preserves bytes.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw
import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("import_legacy", ROOT / "scripts/import_legacy.py")
legacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(legacy)
RUN_ID = "synthetic-legacy"
PEAKS = (0.35, 1.4, 3.05, 3.55, 6.5)


def tree_hashes(directory):
    return {
        path.relative_to(directory).as_posix(): legacy.sha256(path)
        for path in sorted(directory.rglob("*")) if path.is_file()
    }


def synthetic_board(path, size, tiles):
    board = Image.new("RGB", tuple(size), "#d4d8c9")
    draw = ImageDraw.Draw(board)
    for index, tile in enumerate(tiles):
        x, y, width, height = tile["box"]
        color = ((index * 17 + 31) % 180, (index * 23 + 59) % 180,
                 (index * 29 + 83) % 180)
        draw.rectangle((x, y, x + width - 1, y + height - 1), fill=color)
    board.save(path, quality=90, subsampling=0)


@pytest.fixture(scope="module")
def source_project(tmp_path_factory):
    source = tmp_path_factory.mktemp("synthetic-legacy-source")
    overview = {
        "geometry": {"columns": 16, "tile_width": 128,
                     "picture_height": 224, "label_height": 24},
        "size": [2132, 578],
        "frames": [{"index": index, "time": index * 0.5} for index in range(18)],
    }
    settings = {"columns": 14, "tile_width": 168, "tile_height": 176}
    focus = {
        "size": [2441, 987],
        "groups": [
            {"group": {"id": identifier, "start": start, "end": start + 4},
             "frames": [{"index": index, "time": start + index * 0.25}
                        for index in range(17)]}
            for identifier, start in (("A", 0), ("B", 3))
        ],
    }
    clips = [
        {"id": f"h{index + 1:02}", "order": index + 1, "peak": peak,
         "title": f"Synthetic peak {index + 1}",
         "evidence": "Saved fixture decision, not new inference",
         "labels": ["fixture"], "confidence": 0.9}
        for index, peak in enumerate(PEAKS)
    ]
    selections = {
        "visual_rounds_used": 2,
        "clips": list(reversed(clips)) + [
            {"id": "excluded", "order": 0, "peak": 8.0,
             "title": "Excluded fixture", "include": False}
        ],
    }
    timeline = {
        "total_duration": 2.5,
        "clips": [
            {"id": clip["id"], "title": clip["title"],
             "source_start": clip["peak"] - 0.25,
             "source_end": clip["peak"] + 0.25,
             "source_peak": clip["peak"], "output_start": index * 0.5,
             "output_end": (index + 1) * 0.5, "labels": clip["labels"]}
            for index, clip in enumerate(clips)
        ],
    }
    for filename, value in {
        "selections.json": selections,
        "sampling-round1.json": overview,
        "sampling-round2.json": focus,
        "candidate-windows.json": settings,
        "source-output-timeline.json": timeline,
        "visual-rounds.json": {"rounds": 2, "fixture": True},
    }.items():
        legacy.save_json(source / filename, value)
    synthetic_board(source / "round1-overview.jpg", overview["size"],
                    legacy.round1_tiles(overview))
    synthetic_board(source / "round2-focus.jpg", focus["size"],
                    legacy.round2_tiles(focus, settings))
    (source / "stills").mkdir()
    for index, clip in enumerate(clips):
        Image.new("RGB", (96, 128), (40 + index * 20, 80, 120)).save(
            source / "stills" / f"fixture-{clip['id']}.jpg")
    (source / "吃播萌点精选-无BGM.mp4").write_bytes(
        b"SYNTHETIC-VIDEO-COPY-FIXTURE\x00\x01")
    return source


@pytest.fixture(scope="module")
def imported(tmp_path_factory, source_project):
    destination = tmp_path_factory.mktemp("synthetic-legacy-output")
    before = tree_hashes(source_project)
    run = legacy.import_run(source_project, destination, RUN_ID)
    return {"destination": destination, "run": run,
            "source": source_project, "before": before}


def test_round1_geometry_exact(source_project):
    manifest = legacy.load_json(source_project / "sampling-round1.json")
    tiles = legacy.round1_tiles(manifest)
    assert len(tiles) == 18
    assert tiles[0]["box"] == [12, 66, 128, 248]
    assert tiles[16]["box"] == [12, 318, 128, 248]
    assert len({row["id"] for row in tiles}) == len(tiles)
    legacy.validate_tiles(tiles, manifest["size"])


def test_round2_geometry_exact(source_project):
    manifest = legacy.load_json(source_project / "sampling-round2.json")
    settings = legacy.load_json(source_project / "candidate-windows.json")
    tiles = legacy.round2_tiles(manifest, settings)
    assert len(tiles) == 34
    assert tiles[0]["box"] == [12, 116, 168, 200]
    assert tiles[14]["box"] == [12, 321, 168, 200]
    assert tiles[17]["group_id"] == "B"
    assert tiles[17]["box"] == [12, 570, 168, 200]
    legacy.validate_tiles(tiles, manifest["size"])


def test_invalid_boxes_rejected():
    with pytest.raises(ValueError, match="越界"):
        legacy.validate_tiles([{"id": "bad", "box": [10, 10, 100, 100]}], [50, 50])


def test_nearest_peak_deterministic_tie():
    tiles = [
        {"id": "later", "group_id": "overview", "time": 2.0},
        {"id": "earlier", "group_id": "overview", "time": 1.0},
    ]
    selection = [{"id": "h01", "peak": 1.5, "title": "test", "evidence": "existing"}]
    choices = legacy.choose_peak_mappings(selection, tiles, is_overview=True)
    assert choices[0]["frame_id"] == "earlier"
    assert choices[0]["time_error_seconds"] == 0.5
    assert choices[0]["method"] == "nearest_sample_to_saved_peak"


def test_counts_and_peak_identity(imported):
    destination, run = imported["destination"], imported["run"]
    assert [sheet["count"] for sheet in run["sheets"]] == [18, 34]
    assert [sheet["selected_count"] for sheet in run["sheets"]] == [5, 7]
    assert [row["id"] for row in run["selected_frames"]] == [
        "h01", "h02", "h03", "h04", "h05"]
    assert len(run["selected_frames"]) == len(run["timeline"]) == 5
    assert run["video_duration"] == 2.5
    audit = legacy.load_json(destination / RUN_ID / "selection-audit.json")
    assert len(audit["mappings"]) == 12
    assert audit["visual_model_calls"] == audit["visual_inspections"] == 0
    assert {row["source_peak"] for row in audit["mappings"]} == set(PEAKS)


def test_all_boxes_and_peak_errors(imported):
    destination, run = imported["destination"], imported["run"]
    audit = legacy.load_json(destination / RUN_ID / "selection-audit.json")
    sizes = {sheet["id"]: [sheet["width"], sheet["height"]] for sheet in run["sheets"]}
    for mapping in audit["mappings"]:
        legacy.validate_tiles([mapping], sizes[mapping["sheet_id"]])
        assert abs(abs(mapping["time"] - mapping["source_peak"]) - mapping["time_error_seconds"]) < 1e-8
        assert mapping["time_error_seconds"] <= (0.25 if mapping["sheet_id"] == "round1" else 0.125) + 1e-8


def test_original_hashes_and_dimensions_preserved(imported):
    destination, run = imported["destination"], imported["run"]
    for sheet in run["sheets"]:
        output = destination / RUN_ID / Path(sheet["original_url"]).name
        source = imported["source"] / sheet["source_filename"]
        assert legacy.sha256(output) == legacy.sha256(source) == sheet["sha256"]
        annotated = destination / RUN_ID / Path(sheet["annotated_url"]).name
        with Image.open(output) as original, Image.open(annotated) as marked:
            assert original.size == marked.size == (sheet["width"], sheet["height"])
        assert legacy.sha256(annotated) != legacy.sha256(output)
        assert legacy.sha256(annotated) == sheet["annotated_sha256"]


def test_original_video_and_stills_copied_without_change(imported):
    destination, run = imported["destination"], imported["run"]
    copied = destination / RUN_ID / Path(run["video_url"]).name
    assert legacy.sha256(copied) == legacy.sha256(imported["source"] / "吃播萌点精选-无BGM.mp4")
    for frame in run["selected_frames"]:
        copied = destination / RUN_ID / Path(frame["url"]).name
        source = next((imported["source"] / "stills").glob(f"*-{frame['id']}.jpg"))
        assert legacy.sha256(copied) == legacy.sha256(source)


def test_source_inputs_unchanged(imported):
    assert tree_hashes(imported["source"]) == imported["before"]
    audit = legacy.load_json(imported["destination"] / RUN_ID / "selection-audit.json")
    assert all(record["source_unchanged"] for record in audit["copied_files"])


def test_notice_is_historical_not_new_ai(imported):
    run = imported["run"]
    assert "历史" in run["notice"]
    assert "不是重新" in run["notice"]
    assert "最近" in run["notice"]
    assert run["original_visual_rounds"] == 2
    assert run["new_visual_calls"] == 0
    assert run["historical"] is True
    assert all(f"/api/legacy/files/{RUN_ID}/" in sheet["annotated_url"]
               for sheet in run["sheets"])


def test_run_id_rejects_path_traversal(tmp_path, source_project):
    with pytest.raises(ValueError, match="run_id"):
        legacy.import_run(source_project, tmp_path, "../escape")
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("nested", [False, True])
def test_output_cannot_modify_source_tree(source_project, nested):
    before = tree_hashes(source_project)
    destination = source_project / "forbidden-output" if nested else source_project
    with pytest.raises(ValueError, match="历史输入目录只读"):
        legacy.import_run(source_project, destination, RUN_ID)
    assert tree_hashes(source_project) == before
    assert not (source_project / "forbidden-output").exists()


def test_main_manifest_contract(imported):
    destination, run = imported["destination"], imported["run"]
    legacy.update_manifest(destination, run)
    legacy.update_manifest(destination, run)
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    assert manifest == {"runs": [run]}


def test_cli_requires_explicit_source_project(tmp_path, monkeypatch, capsys):
    destination = tmp_path / "must-not-be-created"
    monkeypatch.setattr(sys, "argv", ["import_legacy.py", "--destination", str(destination)])

    def unexpected_import(*args, **kwargs):
        pytest.fail("Missing --source-project must be rejected before reading any input")

    monkeypatch.setattr(legacy, "import_run", unexpected_import)
    with pytest.raises(SystemExit) as error:
        legacy.main()
    assert error.value.code == 2
    assert "--source-project" in capsys.readouterr().err
    assert not destination.exists()


def test_cli_imports_explicit_synthetic_source(source_project, tmp_path, monkeypatch, capsys):
    destination = tmp_path / "cli-output"
    before = tree_hashes(source_project)
    monkeypatch.setattr(sys, "argv", [
        "import_legacy.py", "--source-project", str(source_project),
        "--destination", str(destination), "--run-id", RUN_ID,
    ])
    legacy.main()
    result = json.loads(capsys.readouterr().out)
    assert result["run"] == RUN_ID
    assert result["sheet_counts"] == [18, 34]
    assert result["circle_counts"] == [5, 7]
    assert result["unique_peaks"] == 5
    assert result["new_visual_calls"] == 0
    manifest = legacy.load_json(destination / "manifest.json")
    assert [run["id"] for run in manifest["runs"]] == [RUN_ID]
    assert tree_hashes(source_project) == before
