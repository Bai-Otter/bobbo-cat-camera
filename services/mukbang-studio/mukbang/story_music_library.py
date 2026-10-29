"""Local-only music selection. A job pins its choice before any mixing starts."""
import json
from pathlib import Path
import re
import secrets
from threading import RLock

from . import media

_LOCK = RLock()
_PUBLIC = ('id', 'title', 'artist', 'source_url', 'license', 'license_url', 'attribution', 'style_note')


def _track(value, root):
    if not isinstance(value, dict):
        raise ValueError('BGM曲目格式无效')
    for key in (*_PUBLIC, 'file', 'sha256'):
        if not isinstance(value.get(key), str) or not value[key] or len(value[key]) > 2000:
            raise ValueError('BGM曲目信息不完整')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', value['id']):
        raise ValueError('BGM编号无效')
    if not re.fullmatch(r'[a-f0-9]{64}', value['sha256']):
        raise ValueError('BGM哈希无效')
    if value['license'] != 'CC-BY-4.0' or value['license_url'] != 'https://creativecommons.org/licenses/by/4.0/':
        raise ValueError('BGM许可尚未审核')
    if not value['source_url'].startswith('https://incompetech.com/'):
        raise ValueError('BGM来源尚未审核')
    relative = Path(value['file'])
    path = (root / relative).resolve()
    if relative.is_absolute() or not path.is_relative_to(root.resolve()) or path.suffix.lower() != '.mp3':
        raise ValueError('BGM音频路径无效')
    if not isinstance(value.get('enabled', True), bool):
        raise ValueError('BGM启用状态无效')
    return path


def catalog(profile):
    try:
        manifest = Path(profile['music_library_file'])
        if not manifest.is_absolute():
            raise ValueError
        data = json.loads(manifest.read_text(encoding='utf-8-sig'))
        rows = data['tracks']
        if not isinstance(data['version'], str) or not isinstance(rows, list) or not 1 <= len(rows) <= 100:
            raise ValueError
        for row in rows:
            _track(row, manifest.parent)
        if len({r['id'] for r in rows}) != len(rows) or len({r['sha256'] for r in rows}) != len(rows):
            raise ValueError
        if not any(r.get('enabled', True) for r in rows):
            raise ValueError
        return data, manifest.parent
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError('BGM曲库配置无效；未改用参考音乐') from None


def public_catalog(profile):
    if not profile or not profile.get('music_library_file'):
        return {'mode': 'fixed', 'tracks': [], 'count': 0}
    data, _ = catalog(profile)
    rows = [{**{k: row[k] for k in _PUBLIC}, 'audio_url': f"/api/music/{row['id']}/audio"}
            for row in data['tracks'] if row.get('enabled', True)]
    for output, row in zip(rows, (r for r in data['tracks'] if r.get('enabled', True))):
        url = row.get('preview_url', '')
        if isinstance(url, str) and re.fullmatch(r'/api/jobs/[a-f0-9]{12}/files/local-postprocess/[a-zA-Z0-9_/-]+/preview\.mp4', url):
            output['preview_url'] = url
    return {'mode': 'random_per_job', 'version': data['version'], 'count': len(rows), 'tracks': rows,
            'notice': 'CC BY 4.0：发布视频需携带曲名、作者、来源、许可及修改说明。曲风为初筛候选，请试听。'}


def audio_path(profile, track_id):
    data, root = catalog(profile)
    row = next((r for r in data['tracks'] if r['id'] == track_id and r.get('enabled', True)), None)
    if row is None:
        raise ValueError('BGM曲目不存在')
    path = _track(row, root)
    if not path.is_file() or media.sha256(path) != row['sha256']:
        raise ValueError('BGM文件缺失或哈希不一致')
    return path


def select(profile, job_dir):
    if not profile.get('music_library_file'):
        return profile
    root = Path(profile['music_library_file']).parent
    pin = Path(job_dir) / 'story-music-selection.json'
    try:
        with _LOCK:
            if pin.exists():
                selected = json.loads(pin.read_text(encoding='utf-8'))
                if selected['selection_mode'] != 'random_per_job' or not isinstance(selected['library_version'], str):
                    raise ValueError
                row = selected['track']
            else:
                data, root = catalog(profile)
                row = secrets.choice([r for r in data['tracks'] if r.get('enabled', True)])
                selected = {'selection_mode': 'random_per_job', 'library_version': data['version'], 'track': row}
            path = _track(row, root)
            if not path.is_file() or media.sha256(path) != row['sha256']:
                raise ValueError
            if not pin.exists():
                temp = pin.with_suffix('.tmp')
                media.write_json(temp, selected)
                temp.replace(pin)
        return {**profile, 'music_file': str(path), 'music_sha256': row['sha256'],
                'music_label': row['title'], 'music_rights': 'cc_by_4_0',
                'music_track': {k: row[k] for k in _PUBLIC},
                'music_selection_mode': selected['selection_mode'], 'music_library_version': selected['library_version']}
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError('BGM选曲或已固定音频无效；未偷偷换曲') from None
