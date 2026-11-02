import json
import shutil
from pathlib import Path

import pytest

from mukbang import eating_music, media, story_music_library as library


@pytest.fixture
def approved_pool(tmp_path, monkeypatch):
    rows = []
    for i in range(4):
        path = tmp_path / f'approved-{i}.m4a'
        path.write_bytes(f'local-preview-{i}'.encode())
        url = f'https://www.qishui.com/track/{7000000000000000000 + i}'
        rows.append(dict(id=f'approved-{i}', title=f'Approved {i}', artist='Artist',
                         file=path.name, sha256=media.sha256(path), license='LOCAL-PREVIEW-ONLY',
                         license_url=url, source_url=url, attribution='Commercial rights unconfirmed.',
                         style_note='User approved', enabled=True))
    manifest = tmp_path / 'library.json'
    media.write_json(manifest, dict(version='approved-four-test', usage='local_preview_only',
                                   mix_preset='audition_lufs_v1', tracks=rows))
    monkeypatch.setenv('MUKBANG_EATING_MUSIC_LIBRARY', str(manifest))
    return manifest, rows


def test_approved_four_random_and_retry_pin(approved_pool, tmp_path, monkeypatch):
    profile = eating_music.load()
    seen = set()
    for i in range(4):
        job = tmp_path / f'job-{i}'
        job.mkdir()
        monkeypatch.setattr(library.secrets, 'choice', lambda rows, i=i: rows[i])
        selected = library.select(profile, job, scope='eating')
        seen.add(selected['music_label'])
        assert selected['music_rights'] == 'local_preview_only'
        assert selected['music_mix_preset'] == 'audition_lufs_v1'
        monkeypatch.setattr(library.secrets, 'choice', lambda rows: rows[(i+1) % 4])
        assert library.select(profile, job, scope='eating') == selected
    assert len(seen) == 4
    public = eating_music.public()
    assert public['count'] == 4 and public['mode'] == 'random_per_job'
    assert public['rights_status'] == 'local_preview_only'
    assert str(tmp_path) not in json.dumps(public)
    assert '商用授权待确认' in public['notice']


def test_local_assets_rejected_by_default_and_story(approved_pool, tmp_path):
    manifest, _ = approved_pool
    with pytest.raises(ValueError):
        library.catalog({'music_library_file': str(manifest)})
    profile = eating_music.load()
    with pytest.raises(ValueError):
        library.select(profile, tmp_path, scope='story')
    assert not (tmp_path / 'story-music-selection.json').exists()


@pytest.mark.parametrize('change', ['usage', 'source', 'traversal', 'license'])
def test_local_permission_not_a_general_bypass(approved_pool, change):
    manifest, rows = approved_pool
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if change == 'usage': data.pop('usage')
    if change == 'source': data['tracks'][0]['source_url'] = 'https://unreviewed.invalid/audio'
    if change == 'traversal': data['tracks'][0]['file'] = '../outside.m4a'
    if change == 'license': data['tracks'][0]['license'] = 'unknown'
    media.write_json(manifest, data)
    with pytest.raises(ValueError):
        eating_music.load()


def test_local_audio_hash_still_checked(approved_pool):
    manifest, rows = approved_pool
    profile = eating_music.load()
    (manifest.parent / rows[0]['file']).write_bytes(b'changed')
    with pytest.raises(ValueError):
        library.audio_path(profile, rows[0]['id'])


def test_local_m4a_api_mime(approved_pool, tmp_path):
    from fastapi.testclient import TestClient
    from mukbang.server import create_app
    app = create_app(tmp_path / 'service')
    with TestClient(app) as client:
        response = client.get('/api/eating-music/approved-0/audio', headers={'Range': 'bytes=0-4'})
        assert response.status_code == 206
        assert response.headers['content-type'] == 'audio/mp4'
        assert response.content == b'local'


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg unavailable')
@pytest.mark.parametrize('has_audio', [True, False])
def test_real_approved_mix_loops_with_audition_loudness(approved_pool, tmp_path, has_audio):
    manifest, rows = approved_pool
    source, music = tmp_path / 'source.mp4', tmp_path / rows[0]['file']
    args = ['ffmpeg','-v','error','-f','lavfi','-i','color=size=64x64:rate=5:duration=4']
    if has_audio:
        args += ['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=4']
    media.run(args + ['-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',str(source)])
    media.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=frequency=660:duration=1','-c:a','aac',str(music)])
    rows[0]['sha256'] = media.sha256(music)
    media.write_json(manifest, dict(version='real-test', usage='local_preview_only',
                                   mix_preset='audition_lufs_v1', tracks=rows[:1]))
    result = eating_music.mix(source, tmp_path / 'final.mp4', eating_music.load())
    assert result['bgm_added'] and result['full_decode_pass'] and result['video_bitstream_unchanged']
    assert result['actual_container_duration_seconds'] == pytest.approx(4, abs=.1)
    assert result['source_audio_present'] is has_audio
    assert result['normalization_mode'] == 'two_pass_lufs' and result['music_target_lufs'] == -28
    assert result['rights_status'] == 'local_preview_only' and not result['attribution_required']
    assert not result['speech_duck_windows']


def test_prior_cc_pin_survives_switch_to_local_pool(approved_pool, tmp_path, monkeypatch):
    manifest, _ = approved_pool
    approved = json.loads(manifest.read_text(encoding='utf-8'))
    old = tmp_path / 'old.mp3'
    old.write_bytes(b'old-audio')
    row = dict(id='old', title='Old', artist='Kevin MacLeod', file=old.name, sha256=media.sha256(old),
               source_url='https://incompetech.com/', license='CC-BY-4.0',
               license_url='https://creativecommons.org/licenses/by/4.0/', attribution='Credit', style_note='Old')
    media.write_json(manifest, dict(version='old', tracks=[row]))
    job = tmp_path / 'old-job'
    job.mkdir()
    first = library.select(eating_music.load(), job, scope='eating')
    media.write_json(manifest, approved)
    assert library.select(eating_music.load(), job, scope='eating') == first
    assert first['music_mix_preset'] is None


def test_installer_requires_explicit_preview_and_preserves_active_on_missing_files(tmp_path):
    from scripts.install_approved_eating_music import install
    destination = tmp_path / 'library'
    destination.mkdir()
    manifest = destination / 'library.json'
    manifest.write_text('{"existing":true}', encoding='utf-8')
    with pytest.raises(ValueError):
        install(tmp_path, destination)
    with pytest.raises(ValueError):
        install(tmp_path, destination, local_preview_only=True)
    assert manifest.read_text(encoding='utf-8') == '{"existing":true}'
