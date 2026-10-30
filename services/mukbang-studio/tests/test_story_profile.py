import json

import pytest

from mukbang import story_profile, vision


def test_service_profile_is_opt_in_and_does_not_leak_private_paths(tmp_path, monkeypatch):
    monkeypatch.setenv('MUKBANG_APP_DATA_DIR',str(tmp_path))
    assert story_profile.load() is None
    voice=tmp_path/'voice.json'
    voice.write_text(json.dumps({'voice_id':'private_clone'}),encoding='utf-8')
    settings={'version':'mi-production-v1','voice_file':str(voice),'music_file':str(tmp_path/'music.wav'),
              'music_sha256':'a'*64,'music_label':'参考轻音乐','music_rights':'local_preview_only'}
    (tmp_path/'story-profile.json').write_text(json.dumps(settings),encoding='utf-8')
    profile=story_profile.load()
    assert profile['voice_id']=='private_clone'
    public=story_profile.public(profile)
    assert public['version']=='mi-production-v1'
    assert 'private_clone' not in json.dumps(public) and str(tmp_path) not in json.dumps(public)


def test_broken_profile_is_not_silently_replaced_with_old_voice(tmp_path,monkeypatch):
    monkeypatch.setenv('MUKBANG_APP_DATA_DIR',str(tmp_path))
    (tmp_path/'story-profile.json').write_text('{}')
    with pytest.raises(ValueError): story_profile.load()


def test_mood_policy_requires_a_library_and_retains_confirmed_voice(tmp_path, monkeypatch):
    monkeypatch.setenv('MUKBANG_APP_DATA_DIR', str(tmp_path))
    voice = tmp_path/'voice.json'
    voice.write_text(json.dumps({'voice_id':'same_confirmed_voice'}), encoding='utf-8')
    profile = {'version':'mi-production-v1','voice_file':str(voice),'music_file':str(tmp_path/'music.wav'),
               'music_sha256':'a'*64,'music_label':'参考','music_rights':'local_preview_only',
               'music_selection_policy':'story_mood_v1'}
    path = tmp_path/'story-profile.json'
    path.write_text(json.dumps(profile), encoding='utf-8')
    with pytest.raises(ValueError): story_profile.load()
    profile['music_library_file'] = str(tmp_path/'library.json')
    path.write_text(json.dumps(profile), encoding='utf-8')
    assert story_profile.load()['voice_id'] == 'same_confirmed_voice'


def test_mi_style_is_in_same_prompt_but_not_legacy_eating():
    sampling={'frames':[],'interval':1,'frame_count':0,'sheet_count':0}
    options={'target_duration':40,'min_duration':30,'max_duration':50,'story_enabled':True,'story_mode':'inner_monologue'}
    prompt=vision.build_prompts(options,{'duration':120},sampling)
    assert 'mi-inner-v2' in prompt['system'] and 'performance_direction' in prompt['system']
    assert '前后的反差' in prompt['system'] and '不要连续重复' in prompt['system']
    assert '取消“多数4–12字”' in prompt['system']
    assert '本咪' in prompt['system'] and '近脸' in prompt['system']
    options['story_enabled']=False
    assert 'mi-inner-v2' not in vision.build_prompts(options,{'duration':120},sampling)['system']


def test_style_version_is_taken_from_actual_prompt_not_current_default():
    assert story_profile.detect_style('【mi-inner-v1】旧任务')=='mi-inner-v1'
    assert story_profile.detect_style('【mi-inner-v2】新任务')=='mi-inner-v2'
    assert story_profile.detect_style('没有咪风格的旧提示词')=='legacy'
