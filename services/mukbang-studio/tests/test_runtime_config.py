import json
import os

import pytest


def save(root, **values):
    (root / 'narration-runtime.json').write_text(json.dumps({'version':1, **values}), encoding='utf-8')


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for name in ('MUKBANG_BREEZE_ENABLED', 'BREEZE_API_KEY', 'BREEZE_API_KEY_FILE'):
        monkeypatch.delenv(name, raising=False)


def test_missing_runtime_file_does_not_implicitly_enable_paid_audio(tmp_path):
    from mukbang.runtime_config import apply_saved_narration
    apply_saved_narration(tmp_path)
    assert 'MUKBANG_BREEZE_ENABLED' not in os.environ
    assert 'BREEZE_API_KEY_FILE' not in os.environ


def test_restart_restores_enabled_and_key_pointer_without_reading_key(tmp_path, monkeypatch):
    from mukbang.runtime_config import apply_saved_narration
    from pathlib import Path
    key = tmp_path / 'credential.key'
    key.write_text('test-only-secret')
    save(tmp_path, enabled=True, api_key_file=str(key))
    original = Path.read_text
    def read(path, *args, **kwargs):
        assert path != key, 'Startup loader must not read the secret'
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', read)
    apply_saved_narration(tmp_path)
    assert os.environ['MUKBANG_BREEZE_ENABLED'] == '1'
    assert os.environ['BREEZE_API_KEY_FILE'] == str(key)
    assert 'BREEZE_API_KEY' not in os.environ


def test_explicit_disable_wins_over_saved_enable(tmp_path, monkeypatch):
    from mukbang.runtime_config import apply_saved_narration
    save(tmp_path, enabled=True, api_key_file=str(tmp_path/'missing.key'))
    monkeypatch.setenv('MUKBANG_BREEZE_ENABLED', '0')
    apply_saved_narration(tmp_path)
    assert os.environ['MUKBANG_BREEZE_ENABLED'] == '0'


def test_explicit_credential_wins(tmp_path, monkeypatch):
    from mukbang.runtime_config import apply_saved_narration
    save(tmp_path, enabled=True, api_key_file=str(tmp_path/'missing.key'))
    monkeypatch.setenv('BREEZE_API_KEY', 'test-explicit-secret')
    apply_saved_narration(tmp_path)
    assert os.environ['BREEZE_API_KEY'] == 'test-explicit-secret'
    assert 'BREEZE_API_KEY_FILE' not in os.environ


@pytest.mark.parametrize('payload', [
    {'version':1,'enabled':'true'},
    {'version':1,'enabled':True,'api_key_file':'relative.key'},
    {'version':1,'enabled':True,'api_key':'do-not-expose'},
    {'version':2,'enabled':False},
])
def test_invalid_saved_runtime_rejected_without_exposing_values(tmp_path, payload):
    from mukbang.runtime_config import apply_saved_narration
    (tmp_path/'narration-runtime.json').write_text(json.dumps(payload), encoding='utf-8')
    with pytest.raises(ValueError) as error:
        apply_saved_narration(tmp_path)
    assert 'do-not-expose' not in str(error.value)
    assert 'MUKBANG_BREEZE_ENABLED' not in os.environ


def test_missing_key_fails_before_start_instead_of_silent_audio_loss(tmp_path):
    from mukbang.runtime_config import apply_saved_narration
    save(tmp_path, enabled=True, api_key_file=str(tmp_path/'missing.key'))
    with pytest.raises(ValueError):
        apply_saved_narration(tmp_path)
    assert 'MUKBANG_BREEZE_ENABLED' not in os.environ
