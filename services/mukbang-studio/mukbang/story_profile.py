"""Private per-service production preset; never supplied by a model or browser."""
import json
import os
from pathlib import Path
import re

STYLE_VERSION = 'mi-inner-v2'
VOICE_INSTRUCTIONS = '保持参考音色本身。小猫自己的内心话，普通话，轻快清楚，短停顿，不故意含糊、不拖腔。'


def detect_style(system_prompt):
    """Historical/recovered prompts keep their actual version, not today's default."""
    for version in (STYLE_VERSION, 'mi-inner-v1'):
        if version in system_prompt:
            return version
    return 'legacy'


def load():
    explicit = os.getenv('MUKBANG_STORY_PROFILE_FILE')
    root = os.getenv('MUKBANG_APP_DATA_DIR')
    if not explicit and not root:
        return None
    path = Path(explicit) if explicit else Path(root) / 'story-profile.json'
    if not path.exists() and not explicit:
        return None
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
        if value['version'] != 'mi-production-v1':
            raise ValueError
        for field in ('voice_file', 'music_file'):
            if not isinstance(value[field], str) or not Path(value[field]).is_absolute():
                raise ValueError
        voice = json.loads(Path(value['voice_file']).read_text(encoding='utf-8-sig'))['voice_id']
        if not isinstance(voice, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', voice):
            raise ValueError
        if not re.fullmatch(r'[a-f0-9]{64}', value['music_sha256']):
            raise ValueError
        if value['music_rights'] not in {'local_preview_only', 'licensed'}:
            raise ValueError
        if not isinstance(value['music_label'],str) or not 1 <= len(value['music_label']) <= 120:
            raise ValueError
        if 'music_library_file' in value and (not isinstance(value['music_library_file'], str)
                or not Path(value['music_library_file']).is_absolute()):
            raise ValueError
        if value.get('music_selection_policy', 'random_per_job') not in {'random_per_job', 'story_mood_v1'}:
            raise ValueError
        if value.get('music_selection_policy') == 'story_mood_v1' and not value.get('music_library_file'):
            raise ValueError
        return {**value, 'voice_id':voice}
    except (OSError, ValueError, TypeError, KeyError):
        raise ValueError('咪小剧场预设不完整；未自动退回旧音色，请检查服务私有配置') from None


def public(profile):
    if profile is None:
        return {'version':'legacy-audio', 'style_version':STYLE_VERSION,
                'voice_label':'旧配置音色', 'bgm_enabled':False}
    result = {'version':profile['version'], 'style_version':STYLE_VERSION,
            'voice_label':'已确认的咪参考克隆', 'voice_kind':'authorized-reference-clone',
            'bgm_enabled':True, 'bgm_label':profile['music_label'], 'music_rights':profile['music_rights']}
    if profile.get('music_library_file'):
        from .story_music_library import public_catalog
        pool = public_catalog(profile)
        label = '按剧情匹配' if pool['mode'] == 'story_mood_per_job' else '随机'
        result.update(bgm_label=f"俏皮小猫曲库 · {pool['count']}首{label}", music_rights='cc_by_4_0',
                      music_tags_version=pool['tags_version'],
                      music_mode=pool['mode'], music_library_version=pool['version'], music_track_count=pool['count'])
    return result
