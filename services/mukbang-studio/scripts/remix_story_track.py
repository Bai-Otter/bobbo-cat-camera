"""Explicit single-track audition; no vision, TTS, video re-encoding or old-file overwrite."""
import argparse
import json
import os
from pathlib import Path
import sys

SERVICE = Path('E:/AI/bobbo-cat-camera-dual-videos/services/mukbang-studio')
DATA = SERVICE / 'data/daily-photo-gallery'
sys.path.insert(0, str(SERVICE))
os.environ['MUKBANG_APP_DATA_DIR'] = str(DATA)
from mukbang import media, story_music, story_music_library, story_profile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--job-dir', required=True, type=Path)
parser.add_argument('--track-id', required=True)
parser.add_argument('--name', required=True)
args = parser.parse_args()
if not args.name or Path(args.name).name != args.name or args.name in {'.', '..'}:
    raise SystemExit('Invalid output folder name')
job = args.job_dir.resolve()
source = job / 'interaction-story-voiced.mp4'
if not source.is_file():
    raise SystemExit('Missing voiced intermediate without BGM')
profile = story_profile.load()
catalog, root = story_music_library.catalog(profile)
track = next((row for row in catalog['tracks'] if row['id'] == args.track_id and row.get('enabled', True)), None)
if track is None:
    raise SystemExit('Requested track is absent or disabled')
# Use the registered file/digest and fixed audition selection, not made-up plot tags.
mix_profile = {**profile, 'music_library_file': None, 'music_selection_policy': 'random_per_job',
               'music_file': str(root / track['file']), 'music_sha256': track['sha256'],
               'music_label': track['title'], 'music_rights': 'cc_by_4_0',
               'music_track': {key: track[key] for key in story_music_library._PUBLIC},
               'music_selection_mode': 'audition_fixed', 'music_library_version': catalog['version']}
destination = job / 'local-postprocess' / args.name
destination.mkdir(parents=True, exist_ok=False)
cues = json.loads((job / 'story-inner-monologues.json').read_text(encoding='utf-8'))['cues']
result = story_music.mix(source, destination / 'preview.mp4', cues, mix_profile)
result.update(new_visual_api_calls=0, new_tts_api_calls=0,
              selection_reason='Explicit user-requested replacement audition; original mood classification unchanged')
media.write_json(destination / 'result.json', result)
print(json.dumps({'status': result['status'], 'track': result['label'], 'seconds': round(result['seconds'], 3),
                  'video_bitstream_unchanged': result['video_bitstream_unchanged'],
                  'full_decode_pass': result['full_decode_pass'], 'video': str(destination / 'preview.mp4'),
                  'new_visual_api_calls': 0, 'new_tts_api_calls': 0}, ensure_ascii=False))
