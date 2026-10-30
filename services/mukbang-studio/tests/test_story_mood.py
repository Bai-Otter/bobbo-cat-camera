from copy import deepcopy
import json
import pytest
from mukbang import story_mood as mood


def classification(category='warm', confidence=.9, refs=None):
    return {'category': category, 'confidence': confidence, 'reason': '人贴近猫头，猫停留在人手旁',
            'evidence_frame_ids': ['F0002'] if refs is None else refs}


def rows():
    return json.loads((mood.ROOT/'docs/cat-playful-v1-catalog.json').read_text(encoding='utf-8'))['tracks']


def test_all_twelve_have_readable_tags_and_each_category_has_choices():
    tracks = rows()
    assert len(tracks) == 12
    for track in tracks:
        tagged = mood.track_tags(track['id'])
        assert tagged['labels'] and tagged['scores']
    for category in mood.LABELS:
        recognized = mood.validate(classification(category), {'F0002'})
        candidates, match = mood.candidates(tracks, recognized)
        assert len(candidates) >= 2 and match['category'] == category
        assert match['mode'] == 'story_mood' and match['score'] == 3


def test_warm_never_selects_sneaky_or_comedy_only_track():
    candidates, match = mood.candidates(rows(), mood.validate(classification(), {'F0002'}))
    assert {r['title'] for r in candidates} == {'Carefree', 'Daily Beetle'}
    assert match['classification']['evidence_frame_ids'] == ['F0002']


@pytest.mark.parametrize('raw', [None, {}, [], {'category':'evil'}, classification(confidence=True),
    classification(confidence=float('nan')), classification(confidence=float('inf')),
    classification(refs=['outside']), classification(refs=[]), classification(refs=['F0002','F0002'])])
def test_bad_classification_is_visible_safe_fallback_not_video_failure(raw):
    valid = mood.validate(raw, {'F0002'})
    candidates, match = mood.candidates(rows(), valid)
    assert match['mode'] == 'relaxed_fallback' and match['category'] == 'relaxed'
    assert match['fallback_reason'] and candidates
    assert valid['status'] in {'missing', 'invalid'}


@pytest.mark.parametrize('raw', [classification(confidence=.59), classification(category='uncertain')])
def test_uncertain_falls_back_to_relaxed(raw):
    valid = mood.validate(raw, {'F0002'})
    assert valid['status'] == 'uncertain'
    _, match = mood.candidates(rows(), valid)
    assert match['mode'] == 'relaxed_fallback'


def test_exact_confidence_threshold_and_nonmutation():
    raw = classification(confidence=.6)
    before = deepcopy(raw)
    assert mood.validate(raw, {'F0002'})['status'] == 'ready'
    assert raw == before


def test_unknown_track_cannot_be_guessed_from_title():
    assert mood.track_tags('unreviewed')['labels'] == []
    with pytest.raises(ValueError, match='BGM'):
        mood.candidates([{'id':'unreviewed','title':'Carefree'}], mood.validate(classification(), {'F0002'}))


def test_no_match_does_not_silently_pick_comedy_for_warmth():
    only_sneaky = [r for r in rows() if r['title'] == 'Sneaky Snitch']
    with pytest.raises(ValueError, match='BGM'):
        mood.candidates(only_sneaky, mood.validate(classification(), {'F0002'}))


def test_quantization_losing_mood_evidence_falls_back_not_extends_edit():
    recognized = mood.validate(classification(), {'F0002'})
    clips = [{'co_visible_frame_ids':['F0003']}]
    before = deepcopy(clips)
    checked = mood.for_final_clips(recognized, clips)
    assert checked['status'] == 'invalid' and '帧边界' in checked['fallback_reason']
    assert clips == before
    assert mood.for_final_clips(recognized, [{'co_visible_frame_ids':['F0002']}]) == recognized
