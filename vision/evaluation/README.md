# Feeding-state evaluation

## Cute foodcast continuity baseline

The current experimental continuous-segment baseline is documented in
[`docs/algorithms/2026-08-22-cute-foodcast-continuity-v3.md`](../../docs/algorithms/2026-08-22-cute-foodcast-continuity-v3.md).
It keeps peak ranking separate from temporal continuity and expands selected
peaks into 4–8 second clips. It is not wired into production quick-cut yet.

This directory keeps the evaluation contract separate from production inference.
Videos stay local; tracked manifests contain metadata and SHA256 values only.

Four mutually exclusive states are supported:

- `chewing`
- `licking`
- `not_eating`
- `uncertain`

`uncertain` is excluded from false-positive and activity-score denominators. A
sample with `labelStatus: pending` can be used for pipeline checks and tuning,
but cannot produce accuracy claims.

Validate the supplied dataset:

```powershell
python -m vision.evaluation.cli validate vision/evaluation/datasets/meal-001.json
```

The compressed video is resolved through `BOBBO_MEAL_001_COMPRESSED_VIDEO`.
The normalized raw video is resolved relative to the repository root.

Run the external ChewMeter prototype through the adapter:

```powershell
python -m vision.evaluation.cat_chew_adapter `
  .tmp/algorithm-dataset/normalized/meal-001-raw-portrait.mp4 `
  --cat-chew-dir E:/AI/ClaudeCode/cat-chew `
  --output .tmp/algorithm-dataset/predictions/meal-001-chewmeter.json
```

The adapter maps ChewMeter's binary rhythm result to `chewing` and
`not_eating`. It cannot identify `licking`; this limitation is recorded in its
output and must not be hidden when reviewing metrics.

## Cute positive ranking

After re-running a video analysis and replacing the matching video's frames in
the annotation export, run:

```powershell
python -m vision.evaluation.cute_cli rank-positive bobbo-cute-annotations.json `
  --top-fraction 0.2 --out cute-positive-rank.json
```

The command checks that sampled frames reach the declared video tail, then
analyzes only frames inside human-marked `cute` intervals. Unlabeled frames
are not treated as negatives, so the report is for feature correlation and
candidate ranking only; it does not establish precision, recall, or
cross-video generalization.

For an additional timeline without human labels, generate candidates with:

```powershell
python -m vision.evaluation.cute_cli rank-timeline timeline.json `
  --top-fraction 0.2 --out timeline-candidates.json
```
