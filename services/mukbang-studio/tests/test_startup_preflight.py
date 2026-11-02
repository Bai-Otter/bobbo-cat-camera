from types import SimpleNamespace

import pytest

from scripts import check_story_runtime as preflight


@pytest.fixture
def runtime(monkeypatch):
    state = {'configured': True, 'provider': {'model': 'gpt-6.1-sol'}}
    monkeypatch.setattr(preflight, 'apply_saved_narration', lambda path: None)
    monkeypatch.setattr(preflight, 'ProviderConfig', lambda: SimpleNamespace(public=lambda: state))
    monkeypatch.setattr(preflight.narration, 'enabled', lambda: True)
    monkeypatch.setattr(preflight.narration, 'configured', lambda: SimpleNamespace(voice_label='confirmed'))
    monkeypatch.setattr(preflight.story_profile, 'load', lambda: {})
    monkeypatch.setattr(preflight.story_profile, 'public', lambda _: {'bgm_enabled': True})
    monkeypatch.setenv('MUKBANG_APP_DATA_DIR', 'test-placeholder')
    return state


def test_complete_startup_snapshot_is_public_and_offline(tmp_path, runtime):
    result = preflight.check_runtime(tmp_path, 'gpt-6.1-sol')
    assert result == {'ai_configured': True, 'provider': runtime['provider'],
                      'story_production_profile': {'bgm_enabled': True},
                      'narration_enabled': True, 'voice_label': 'confirmed',
                      'story_bgm_enabled': True, 'api_calls': 0}


def test_missing_ai_rejects_otherwise_working_story(tmp_path, runtime):
    runtime['configured'] = False
    with pytest.raises(ValueError, match='AI is not configured'):
        preflight.check_runtime(tmp_path)


def test_wrong_model_rejected(tmp_path, runtime):
    runtime['provider']['model'] = 'wrong-model'
    with pytest.raises(ValueError, match='model'):
        preflight.check_runtime(tmp_path, 'gpt-6.1-sol')


@pytest.mark.parametrize('component', ['narration', 'music'])
def test_missing_story_component_rejected(tmp_path, runtime, monkeypatch, component):
    if component == 'narration':
        monkeypatch.setattr(preflight.narration, 'enabled', lambda: False)
    else:
        monkeypatch.setattr(preflight.story_profile, 'public', lambda _: {'bgm_enabled': False})
    with pytest.raises(ValueError):
        preflight.check_runtime(tmp_path)
