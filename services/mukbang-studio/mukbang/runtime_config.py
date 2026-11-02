"""Restore explicitly saved local narration settings; never store/read secret values here."""
import json
import os
from pathlib import Path


def apply_saved_narration(data_dir):
    path = Path(data_dir) / 'narration-runtime.json'
    if not path.exists():
        return
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
        if (not isinstance(value, dict) or set(value) - {'version','enabled','api_key_file'}
                or type(value.get('version')) is not int or value['version'] != 1
                or not isinstance(value.get('enabled'), bool)):
            raise ValueError
        key_file = value.get('api_key_file', '')
        if not isinstance(key_file, str) or (key_file and not Path(key_file).is_absolute()):
            raise ValueError
        updates = {}
        if 'MUKBANG_BREEZE_ENABLED' not in os.environ:
            updates['MUKBANG_BREEZE_ENABLED'] = '1' if value['enabled'] else '0'
        enabled = os.environ.get('MUKBANG_BREEZE_ENABLED', updates.get('MUKBANG_BREEZE_ENABLED', '')).lower() in {'1','true','yes'}
        if enabled and not os.getenv('BREEZE_API_KEY', '').strip() and not os.getenv('BREEZE_API_KEY_FILE', '').strip():
            if not key_file or not Path(key_file).is_file():
                raise ValueError
            updates['BREEZE_API_KEY_FILE'] = key_file
        os.environ.update(updates)
    except (OSError, ValueError, TypeError):
        raise ValueError('本地配音启动配置无效或凭证文件缺失；未启动为静默无配音模式') from None
