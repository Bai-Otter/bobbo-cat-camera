"""Independent eating music configuration; local random selection, zero AI calls."""
import os
from pathlib import Path

from . import story_music_library, story_music


def load():
    explicit = os.getenv('MUKBANG_EATING_MUSIC_LIBRARY')
    root = os.getenv('MUKBANG_APP_DATA_DIR')
    if not explicit and not root:
        return None
    path = Path(explicit) if explicit else Path(root) / 'music-eating' / 'library.json'
    if not explicit and not path.exists():
        return None
    profile = {'music_library_file': str(path.resolve()), 'music_selection_policy': 'random_per_job'}
    story_music_library.catalog(profile)
    return profile


def public():
    try:
        profile = load()
        pool = story_music_library.public_catalog(profile, scope='eating')
        return {**pool, 'enabled': bool(profile), 'scope': 'eating',
                'notice': '吃播独立曲库，每个新任务等概率随机选一首；保留原声、不加配音。发布请附带音乐署名。'}
    except ValueError as exc:
        return {'status': 'invalid', 'enabled': False, 'scope': 'eating', 'count': 0, 'tracks': [], 'reason': str(exc)}


def mix(video, destination, profile, cancelled=None):
    return story_music.mix(video, destination, [], profile, cancelled, scope='eating')
