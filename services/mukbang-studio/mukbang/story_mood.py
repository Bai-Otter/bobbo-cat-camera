"""Non-critical story mood attestation and deterministic candidate filtering.

The model labels the selected story in its existing visual response. Local
curation maps that label to music; this does not independently verify emotion.
"""
from copy import deepcopy
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_TAGS = json.loads((ROOT/'prompts/story-music-tags-v1.json').read_text(encoding='utf-8'))
TAG_VERSION = _TAGS['version']
LABELS = _TAGS['categories']
VERSION = 'story-music-mood-v1'


def track_tags(ident):
    scores = dict(_TAGS['tracks'].get(ident, {}))
    keys = sorted((k for k in LABELS if scores.get(k, 0) >= 2), key=lambda k: -scores[k])
    return {'version': TAG_VERSION, 'categories': keys, 'labels': [LABELS[k] for k in keys], 'scores': scores}


def validate(raw, allowed_frames):
    """Missing/invalid mood never invalidates an otherwise valid story."""
    base = {'version': VERSION, 'category': 'uncertain', 'label': '暂不确定',
            'confidence': None, 'reason': '', 'evidence_frame_ids': []}
    if raw is None:
        return {**base, 'status': 'missing', 'fallback_reason': '本次响应未提供剧情类别，使用轻松日常配乐'}
    try:
        category, confidence, reason, refs = (raw[k] for k in ('category','confidence','reason','evidence_frame_ids'))
        if not isinstance(category, str) or category not in {*LABELS, 'uncertain'}:
            raise ValueError
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError
        if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 160:
            raise ValueError
        if not isinstance(refs, list) or not 1 <= len(refs) <= 6 or not all(isinstance(r, str) for r in refs):
            raise ValueError
        if len(set(refs)) != len(refs) or not set(refs).issubset(allowed_frames):
            raise ValueError
        uncertain = confidence < .6 or category == 'uncertain'
        return {**base, 'category': category, 'label': LABELS.get(category, '暂不确定'),
                'confidence': float(confidence), 'reason': reason.strip(), 'evidence_frame_ids': list(refs),
                'status': 'uncertain' if uncertain else 'ready',
                'fallback_reason': '剧情类别把握不足，使用轻松日常配乐' if uncertain else ''}
    except (KeyError, TypeError, ValueError, OverflowError):
        return {**base, 'status': 'invalid', 'fallback_reason': '剧情分类字段或片内证据无效，使用轻松日常配乐'}


def for_final_clips(classification, clips):
    """Frame-aligned edits may remove an edge sample; do not retain its label."""
    if not isinstance(classification, dict) or classification.get('status') not in {'ready', 'uncertain'}:
        return deepcopy(classification)
    allowed = {ref for clip in clips for ref in clip['co_visible_frame_ids']}
    checked = validate(classification, allowed)
    if checked['status'] == 'invalid':
        checked['fallback_reason'] = '帧边界对齐后剧情分类证据不再完整，使用轻松日常配乐'
    return checked


def candidates(tracks, classification):
    classification = deepcopy(classification) if isinstance(classification, dict) else validate(None, set())
    reliable = (classification.get('version') == VERSION and classification.get('status') == 'ready'
                and isinstance(classification.get('category'), str) and classification['category'] in LABELS)
    category = classification['category'] if reliable else 'relaxed'
    scored = [(row, track_tags(row['id'])['scores'].get(category, 0)) for row in tracks]
    maximum = max((score for _, score in scored), default=0)
    if maximum < 2:
        raise ValueError('BGM曲库没有适合当前剧情的已标注曲目；未跨类别盲选')
    choices = [row for row, score in scored if score == maximum]
    return choices, {'version': VERSION, 'tags_version': TAG_VERSION,
                     'mode': 'story_mood' if reliable else 'relaxed_fallback',
                     'category': category, 'label': LABELS[category], 'score': maximum,
                     'candidate_ids': [row['id'] for row in choices], 'classification': classification,
                     'fallback_reason': '' if reliable else classification.get('fallback_reason') or '缺少可靠剧情分类，使用轻松日常配乐'}
