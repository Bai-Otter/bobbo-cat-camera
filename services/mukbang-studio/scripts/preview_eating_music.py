"""Create an isolated local audition from an existing eating export, without AI."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang import eating_music, media


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('job_id')
    parser.add_argument('--data-dir', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{12}', args.job_id):
        parser.error('Expected a 12-hex job ID')
    root = args.data_dir.resolve()
    os.environ['MUKBANG_APP_DATA_DIR'] = str(root)
    profile = eating_music.load()
    if not profile:
        parser.error('Install eating music first')
    job = root / 'jobs' / args.job_id
    source = job / 'highlights.mp4'
    original_hash = media.sha256(source)
    folder = job / 'local-postprocess' / ('eating-bgm-' + uuid.uuid4().hex[:12])
    folder.mkdir(parents=True, exist_ok=False)
    report = eating_music.mix(source, folder / 'preview.mp4', profile)
    report.update(video_url=media.artifact_url(job, (folder/'preview.mp4').relative_to(job)),
                  credits_url=media.artifact_url(job, (folder/'eating-music-credits.txt').relative_to(job)),
                  source_job_id=args.job_id, source_sha256=original_hash, ai_call_count=0,
                  created_at=datetime.now(timezone.utc).isoformat(),
                  original_job_unchanged=True)
    if media.sha256(source) != original_hash:
        raise RuntimeError('Source changed')
    media.write_json(folder / 'report.json', report)
    manifest = Path(profile['music_library_file'])
    data = json.loads(manifest.read_text(encoding='utf-8'))
    for row in data['tracks']:
        if row['id'] == report['track']['id']:
            row['preview_url'] = report['video_url']
    temp = manifest.with_suffix('.preview.tmp')
    media.write_json(temp, data)
    temp.replace(manifest)
    print(json.dumps({'video': str(folder/'preview.mp4'), 'url': report['video_url'],
                      'track': report['label'], 'seconds': report['seconds'],
                      'ai_calls': 0}, ensure_ascii=False))


if __name__ == '__main__':
    main()
