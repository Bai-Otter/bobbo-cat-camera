import json
from pathlib import Path
import pytest
from mukbang import media, story_music_library as library


@pytest.fixture
def pool(tmp_path):
    tracks = []
    for i in range(12):
        f = tmp_path / f'{i}.mp3'
        f.write_bytes(f'audio-{i}'.encode())
        tracks.append({'id': f'track-{i}', 'title': f'Music {i}', 'artist': 'Artist', 'file': f.name,
                       'sha256': media.sha256(f), 'license': 'CC-BY-4.0',
                       'license_url': 'https://creativecommons.org/licenses/by/4.0/',
                       'source_url': 'https://incompetech.com/music/', 'attribution': 'Credit with license',
                       'style_note': 'playful', 'enabled': True})
    manifest = tmp_path / 'library.json'
    media.write_json(manifest, {'version': 'test-v1', 'tracks': tracks})
    return {'music_library_file': str(manifest), 'music_file': 'legacy.wav'}, tracks


def test_legacy_fixed_profile_unchanged(tmp_path):
    profile = {'music_file': 'original.wav'}
    assert library.select(profile, tmp_path) is profile


def test_random_is_pinned_to_job_and_keeps_metadata(pool, tmp_path, monkeypatch):
    profile, tracks = pool
    job = tmp_path / 'job'
    job.mkdir()
    monkeypatch.setattr(library.secrets, 'choice', lambda rows: rows[3])
    selected = library.select(profile, job)
    assert selected['music_label'] == 'Music 3'
    monkeypatch.setattr(library.secrets, 'choice', lambda rows: rows[9])
    assert library.select(profile, job) == selected
    assert selected['music_rights'] == 'cc_by_4_0'
    assert selected['music_track']['attribution']
    assert str(tmp_path) not in json.dumps(library.public_catalog(profile))


def test_new_jobs_can_choose_different_tracks(pool, tmp_path, monkeypatch):
    profile, _ = pool
    seen = set()
    for i in range(12):
        monkeypatch.setattr(library.secrets, 'choice', lambda rows, i=i: rows[i])
        job = tmp_path / f'job-{i}'
        job.mkdir()
        seen.add(library.select(profile, job)['music_label'])
    assert len(seen) == 12


def test_pinned_track_survives_reordering_or_disabling(pool, tmp_path, monkeypatch):
    profile, tracks = pool
    job = tmp_path / 'job'
    job.mkdir()
    monkeypatch.setattr(library.secrets, 'choice', lambda rows: rows[0])
    first = library.select(profile, job)
    tracks[0]['enabled'] = False
    media.write_json(Path(profile['music_library_file']), {'version': 'v2', 'tracks': list(reversed(tracks))})
    assert library.select(profile, job)['music_sha256'] == first['music_sha256']


def test_changed_selected_file_fails_not_switches(pool, tmp_path, monkeypatch):
    profile, _ = pool
    job = tmp_path / 'job'
    job.mkdir()
    first = library.select(profile, job)
    Path(first['music_file']).write_bytes(b'changed')
    with pytest.raises(ValueError, match='BGM'):
        library.select(profile, job)


@pytest.mark.parametrize('change', ['traversal', 'duplicate', 'license', 'empty', 'bad_snapshot'])
def test_invalid_catalog_or_pin_rejected(pool, tmp_path, change):
    profile, tracks = pool
    job = tmp_path / 'job'
    job.mkdir()
    if change == 'traversal': tracks[0]['file'] = '../outside.mp3'
    if change == 'duplicate': tracks[1]['id'] = tracks[0]['id']
    if change == 'license': tracks[0]['license'] = 'unknown'
    if change == 'empty': tracks = []
    if change == 'bad_snapshot': (job / 'story-music-selection.json').write_text('{}')
    media.write_json(Path(profile['music_library_file']), {'version': 'v1', 'tracks': tracks})
    with pytest.raises(ValueError, match='BGM'):
        library.select(profile, job)


def test_music_api_exposes_only_registered_audio_and_public_fields(pool, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from mukbang import server, story_profile
    profile, tracks = pool
    monkeypatch.setattr(story_profile, 'load', lambda: profile)
    app = server.create_app(tmp_path / 'service')
    try:
        with TestClient(app) as client:
            response = client.get('/api/music')
            assert response.status_code == 200
            assert response.json()['count'] == 12
            assert str(tmp_path) not in response.text
            assert 'legacy.wav' not in response.text
            audio = client.get('/api/music/track-0/audio', headers={'Range': 'bytes=0-4'})
            assert audio.status_code == 206 and audio.content == b'audio'
            assert client.get('/api/music/missing/audio').status_code == 404
            assert client.get('/music').status_code == 200
            Path(profile['music_library_file']).write_text('{}')
            assert client.get('/api/music').status_code == 503
            assert client.get('/api/music/track-0/audio').status_code == 404
    finally:
        app.state.manager.executor.shutdown(wait=True, cancel_futures=True)


def test_pinned_selection_atomic_under_same_job_threads(pool, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    profile, _ = pool
    job = tmp_path / 'job'
    job.mkdir()
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: library.select(profile, job), range(10)))
    assert len({row['music_sha256'] for row in results}) == 1


@pytest.fixture
def tagged_pool(pool):
    from mukbang import story_mood
    profile, tracks = pool
    original = json.loads((story_mood.ROOT/'docs/cat-playful-v1-catalog.json').read_text(encoding='utf-8'))['tracks']
    for track, real in zip(tracks, original):
        track.update(id=real['id'], title=real['title'])
    media.write_json(Path(profile['music_library_file']), {'version':'test-tagged','tracks':tracks})
    return {**profile, 'music_selection_policy':'story_mood_v1'}, tracks


@pytest.mark.parametrize('category',['warm','funny','sneaky','proud','relaxed'])
def test_mood_policy_filters_before_random_and_pins_full_match(tagged_pool, tmp_path, monkeypatch, category):
    from mukbang import story_mood
    profile, tracks = tagged_pool
    recognized = story_mood.validate({'category':category,'confidence':.85,'reason':'实际片内互动',
                                     'evidence_frame_ids':['F0001']}, {'F0001'})
    expected, _ = story_mood.candidates(tracks, recognized)
    choices = []
    def choose(rows):
        choices.extend(r['id'] for r in rows)
        return rows[-1]
    monkeypatch.setattr(library.secrets, 'choice', choose)
    job = tmp_path/'job'
    job.mkdir()
    result = library.select(profile, job, recognized)
    assert choices == [r['id'] for r in expected]
    assert result['music_match']['classification'] == recognized
    assert result['music_selection_mode'] == 'story_mood_per_job'
    assert result['music_track']['mood_tags']['labels']
    assert result == library.select(profile, job, story_mood.validate(None, set()))
    assert len(choices) == len(expected)  # No second choice during retry.
    assert library.public_catalog(profile)['mode'] == 'story_mood_per_job'


def test_old_random_pin_does_not_change_when_policy_is_enabled(tagged_pool, tmp_path):
    profile, _ = tagged_pool
    job = tmp_path/'job'
    job.mkdir()
    original = library.select({**profile,'music_selection_policy':'random_per_job'}, job)
    later = library.select(profile, job)
    assert later['music_sha256'] == original['music_sha256']
    assert later['music_selection_mode'] == 'random_per_job' and 'music_match' not in later


def test_missing_mood_under_new_policy_has_explicit_relaxed_fallback(tagged_pool, tmp_path):
    profile, _ = tagged_pool
    job = tmp_path/'job'
    job.mkdir()
    result = library.select(profile, job)
    assert result['music_match']['mode'] == 'relaxed_fallback'
    assert result['music_label'] in {'Carefree','Daily Beetle','Plucky Daisy'}


def test_tagged_api_keeps_every_track_labeled(tagged_pool):
    public = library.public_catalog(tagged_pool[0])
    assert all(row['mood_tags']['labels'] for row in public['tracks'])
    assert len(public['categories']) == 5
