import json
import shutil

import pytest

from mukbang import eating_music, media, story_music_library as library


@pytest.fixture
def eating_pool(tmp_path, monkeypatch):
    tracks = []
    for i in range(10):
        audio = tmp_path / f'{i}.mp3'
        audio.write_bytes(f'fixture-{i}'.encode())
        tracks.append({'id': f'eating-{i}', 'title': f'Gentle {i}', 'artist': 'Kevin MacLeod',
                       'file': audio.name, 'sha256': media.sha256(audio), 'license': 'CC-BY-4.0',
                       'license_url': 'https://creativecommons.org/licenses/by/4.0/',
                       'source_url': 'https://incompetech.com/', 'attribution': 'Test attribution',
                       'style_note': 'gentle', 'enabled': True})
    path = tmp_path / 'library.json'
    media.write_json(path, {'version': 'test-eating', 'tracks': tracks})
    monkeypatch.setenv('MUKBANG_EATING_MUSIC_LIBRARY', str(path))
    return eating_music.load(), tracks


def test_eating_random_scope_independent_and_pinned(eating_pool, tmp_path, monkeypatch):
    profile, tracks = eating_pool
    job = tmp_path / 'job'
    job.mkdir()
    monkeypatch.setattr(library.secrets, 'choice', lambda rows: rows[2])
    first = library.select(profile, job, scope='eating')
    monkeypatch.setattr(library.secrets, 'choice', lambda rows: rows[5])
    story = library.select(profile, job)
    assert story['music_label'] == 'Gentle 5'
    assert library.select(profile, job, scope='eating') == first
    assert first['music_label'] == 'Gentle 2'
    assert (job / 'eating-music-selection.json').is_file()
    assert (job / 'story-music-selection.json').is_file()
    seen = set()
    for i in range(10):
        next_job = tmp_path / f'job-{i}'
        next_job.mkdir()
        monkeypatch.setattr(library.secrets, 'choice', lambda rows, i=i: rows[i])
        seen.add(library.select(profile, next_job, scope='eating')['music_label'])
    assert len(seen) == 10


def test_public_pool_has_ten_distinct_tracks_no_private_paths(eating_pool, tmp_path):
    value = eating_music.public()
    assert value['enabled'] and value['count'] == 10 and value['mode'] == 'random_per_job'
    assert str(tmp_path) not in json.dumps(value)
    assert all(t['audio_url'].startswith('/api/eating-music/') for t in value['tracks'])


def test_no_implicit_enable_and_bad_explicit_config_is_visible(tmp_path, monkeypatch):
    monkeypatch.delenv('MUKBANG_EATING_MUSIC_LIBRARY', raising=False)
    monkeypatch.setenv('MUKBANG_APP_DATA_DIR', str(tmp_path))
    assert eating_music.load() is None
    monkeypatch.setenv('MUKBANG_EATING_MUSIC_LIBRARY', str(tmp_path / 'missing.json'))
    assert eating_music.public()['status'] == 'invalid'
    with pytest.raises(ValueError):
        eating_music.load()


def test_eating_api_serves_registered_tracks_only(eating_pool, tmp_path):
    from fastapi.testclient import TestClient
    from mukbang import server
    app = server.create_app(tmp_path / 'service')
    with TestClient(app) as client:
        assert client.get('/api/eating-music').json()['count'] == 10
        assert client.get('/api/config').json()['eating_music']['enabled']
        assert client.get('/api/eating-music/eating-0/audio').content == b'fixture-0'
        assert client.get('/api/eating-music/not-registered/audio').status_code == 404
        assert client.get('/eating-music').status_code == 200


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg unavailable')
@pytest.mark.parametrize('has_audio', [True, False])
def test_long_eating_mix_and_silent_source(tmp_path, has_audio):
    source, music, final = tmp_path/'source.mp4', tmp_path/'track.mp3', tmp_path/'final.mp4'
    args = ['ffmpeg','-v','error','-f','lavfi','-i','color=size=64x64:rate=2:duration=65']
    if has_audio:
        args += ['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=65']
    media.run(args + ['-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',str(source)])
    media.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=660:duration=1',str(music)])
    profile = {'music_file':str(music),'music_sha256':media.sha256(music),'music_label':'fixture','music_rights':'licensed'}
    report = eating_music.mix(source, final, profile)
    assert report['bgm_added'] and report['full_decode_pass'] and report['video_bitstream_unchanged']
    assert report['source_audio_present'] is has_audio
    assert report['actual_container_duration_seconds'] == pytest.approx(65, abs=.1)
    assert report['nominal_rms_dbfs'] == -32 and not report['speech_duck_windows']
    assert 'no narration' in report['audio_policy']
    assert (tmp_path/'eating-music-normalization.wav').is_file()
    assert not (tmp_path/'story-music-normalization.wav').exists()
