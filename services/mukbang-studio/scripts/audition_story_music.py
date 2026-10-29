"""Make isolated same-video music comparisons, with no vision or TTS requests."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang import media, story_music, story_music_library


def audition(job_dir, library_file, name):
    job_dir = Path(job_dir).resolve()
    library_file = Path(library_file).resolve()
    data, music_root = story_music_library.catalog({'music_library_file': str(library_file)})
    source = job_dir / 'interaction-story-voiced.mp4'
    if not source.is_file():
        raise ValueError('Need the voiced intermediate WITHOUT existing BGM')
    cues = json.loads((job_dir/'story-inner-monologues.json').read_text(encoding='utf-8'))['cues']
    output = job_dir / 'local-postprocess' / name
    output.mkdir(parents=True, exist_ok=False)
    reports = []
    for track in data['tracks']:
        destination = output / track['id']
        destination.mkdir()
        profile = {'music_file': str(music_root / track['file']), 'music_sha256': track['sha256'],
                   'music_label': track['title'], 'music_rights': 'cc_by_4_0',
                   'music_track': {k: track[k] for k in story_music_library._PUBLIC},
                   'music_selection_mode': 'audition_fixed', 'music_library_version': data['version']}
        result = story_music.mix(source, destination/'preview.mp4', cues, profile)
        result['credits_url'] = media.artifact_url(job_dir, (destination/'story-music-credits.txt').relative_to(job_dir))
        result.update(source_job_id=job_dir.name, new_visual_api_calls=0, new_tts_api_calls=0)
        media.write_json(destination/'result.json', result)
        track['preview_url'] = media.artifact_url(job_dir, (destination/'preview.mp4').relative_to(job_dir))
        reports.append(result)
        print(f"Mixed and verified: {track['title']} ({result['seconds']:.2f}s)", flush=True)
    media.write_json(output/'summary.json', {'source_job_id': job_dir.name, 'reports': reports})
    temporary = library_file.with_suffix('.audition.tmp')
    media.write_json(temporary, data)
    temporary.replace(library_file)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job-dir', required=True, type=Path)
    parser.add_argument('--library', required=True, type=Path)
    parser.add_argument('--name', default='music-audition-v1')
    args = parser.parse_args()
    if not args.name or Path(args.name).name != args.name or args.name in {'.', '..'}:
        parser.error('name must be a single folder name')
    audition(args.job_dir, args.library, args.name)
