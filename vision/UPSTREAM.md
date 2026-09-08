# Embedded Cat Vision Model

This directory is a vendored snapshot of:

- Repository: `https://github.com/lil-goat/cat-vision-inference`
- Main merge commit: `f56e8d36eaa850c8095a932de6a3ef5cf9c58408`
- Feature commit: `2353a30` (`feat: add hybrid cat feeding detection v1`)

The snapshot contains the recording analyzer, model loaders, behavior fusion, marker generation, dependencies, and focused tests required by the full-stack repository.

Model weight binaries are not committed to normal Git history. The source pins their model names or download locations:

- YOLO cat detector: `yolo11s.pt`
- YOLO segmentation fallback: `yolo11s-seg.pt`
- Animal pose: ViTPose-S APT36K ONNX from `JunkyByte/easy_ViTPose`
- Cat face: CatFLW localizer and 48-point landmark TFLite models from `hugocornellier/cat_detection`

Install the Python runtime with:

```powershell
python -m pip install -r vision/requirements.txt
```

To update the snapshot, merge and verify the model repository first, copy the same file set from its clean `main` commit, update the commit identifiers above, and run both the vendored Python tests and the full-stack Node/mini-program tests.
