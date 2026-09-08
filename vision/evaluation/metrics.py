from __future__ import annotations

from collections import defaultdict
from typing import Any

from .dataset import ALLOWED_STATES, DatasetValidationError

EATING_STATES = {"chewing", "licking"}


def _state_at(intervals: list[dict[str, Any]], start: float, end: float) -> str | None:
    for interval in intervals:
        if float(interval["startSec"]) <= start and end <= float(interval["endSec"]):
            return str(interval["state"])
    return None


def evaluate_sample(
    ground_truth: list[dict[str, Any]],
    predictions: list[dict[str, Any]],
) -> dict[str, Any]:
    boundaries = sorted({
        float(interval[key])
        for interval in ground_truth + predictions
        for key in ("startSec", "endSec")
    })
    confusion: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    ground_eating = 0.0
    predicted_eating = 0.0
    eating_true_positive = 0.0
    non_eating_seconds = 0.0
    eating_false_positive = 0.0
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        truth = _state_at(ground_truth, start, end)
        predicted = _state_at(predictions, start, end)
        if truth not in ALLOWED_STATES or predicted not in ALLOWED_STATES:
            continue
        seconds = end - start
        confusion[truth][predicted] += seconds
        truth_eating = truth in EATING_STATES
        predicted_eating_state = predicted in EATING_STATES
        if truth_eating:
            ground_eating += seconds
        if predicted_eating_state:
            predicted_eating += seconds
        if truth_eating and predicted_eating_state:
            eating_true_positive += seconds
        if truth == "not_eating":
            non_eating_seconds += seconds
            if predicted_eating_state:
                eating_false_positive += seconds
    per_state: dict[str, dict[str, float]] = {}
    for state in sorted(ALLOWED_STATES):
        true_positive = confusion[state][state]
        predicted_total = sum(row[state] for row in confusion.values())
        truth_total = sum(confusion[state].values())
        precision = true_positive / predicted_total if predicted_total else 0.0
        recall = true_positive / truth_total if truth_total else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_state[state] = {"precision": precision, "recall": recall, "f1": f1, "supportSeconds": truth_total}
    return {
        "perState": per_state,
        "combinedEatingRecall": eating_true_positive / ground_eating if ground_eating else 0.0,
        "nonEatingFalsePositiveRate": eating_false_positive / non_eating_seconds if non_eating_seconds else 0.0,
        "actualEatingDurationErrorSeconds": abs(predicted_eating - ground_eating),
        "groundTruthEatingSeconds": ground_eating,
        "predictedEatingSeconds": predicted_eating,
    }


def evaluate_dataset(samples: list[dict[str, Any]]) -> dict[str, Any]:
    if not samples:
        raise DatasetValidationError("EVALUATION_SAMPLES_REQUIRED")
    if any(sample.get("labelStatus") != "complete" for sample in samples):
        raise DatasetValidationError("GROUND_TRUTH_INCOMPLETE")
    results = [evaluate_sample(sample["labels"], sample.get("predictions") or []) for sample in samples]
    return {
        "sampleCount": len(results),
        "combinedEatingRecall": sum(item["combinedEatingRecall"] for item in results) / len(results),
        "nonEatingFalsePositiveRate": sum(item["nonEatingFalsePositiveRate"] for item in results) / len(results),
        "actualEatingDurationMaeSeconds": sum(item["actualEatingDurationErrorSeconds"] for item in results) / len(results),
        "samples": results,
    }
