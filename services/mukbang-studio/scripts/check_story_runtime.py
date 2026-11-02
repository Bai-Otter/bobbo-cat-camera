"""Read-only startup preflight: no API requests, no credential output, no paid synthesis."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang.runtime_config import apply_saved_narration
from mukbang import narration, story_profile
from mukbang.config import ProviderConfig


def check_runtime(data_dir: Path, expected_ai_model: str | None = None) -> dict:
    os.environ['MUKBANG_APP_DATA_DIR'] = str(data_dir.resolve())
    apply_saved_narration(data_dir.resolve())
    ai = ProviderConfig().public()
    if not ai['configured']:
        raise ValueError('AI is not configured; restore the saved provider before restarting.')
    if expected_ai_model and ai['provider']['model'] != expected_ai_model:
        raise ValueError('AI model does not match the expected model; nothing should be restarted.')
    if not narration.enabled():
        raise ValueError('Narration is disabled; stop before restarting the service.')
    config = narration.configured()
    public = story_profile.public(story_profile.load())
    if not public.get('bgm_enabled'):
        raise ValueError('Story BGM is not enabled')
    return {'ai_configured': True, 'provider': ai['provider'],
            'story_production_profile': public,
            'narration_enabled': True, 'voice_label': config.voice_label,
            'story_bgm_enabled': True, 'api_calls': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--expected-ai-model')
    args = parser.parse_args()
    try:
        result = check_runtime(args.data_dir, args.expected_ai_model)
    except (ValueError, narration.NarrationError):
        raise SystemExit('AI/narration preflight failed; check saved provider, expected model and narration configuration locally.') from None
    print(json.dumps(result, ensure_ascii=False))
