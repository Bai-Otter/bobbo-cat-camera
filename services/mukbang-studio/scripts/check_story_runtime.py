"""Read-only startup preflight: no API requests, no credential output, no paid synthesis."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang.runtime_config import apply_saved_narration
from mukbang import narration, story_profile


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    args = parser.parse_args()
    os.environ['MUKBANG_APP_DATA_DIR'] = str(args.data_dir.resolve())
    apply_saved_narration(args.data_dir.resolve())
    if not narration.enabled():
        raise SystemExit('Narration is disabled; stop before restarting the service.')
    try:
        config = narration.configured()
        public = story_profile.public(story_profile.load())
        if not public.get('bgm_enabled'):
            raise ValueError('Story BGM is not enabled')
    except (ValueError, narration.NarrationError):
        raise SystemExit('Narration preflight failed; check saved configuration and credential file locally.') from None
    print(json.dumps({'narration_enabled': True, 'voice_label': config.voice_label,
                      'story_bgm_enabled': public['bgm_enabled'], 'api_calls':0}, ensure_ascii=False))
