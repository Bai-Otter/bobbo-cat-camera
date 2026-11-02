"""Install four already-obtained audition assets locally; no network or commercial-rights claim."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mukbang import media, story_music_library


def install(source_directory, destination, *, local_preview_only=False):
    if not local_preview_only:
        raise ValueError('Explicit local-preview-only acknowledgement required; commercial rights are unconfirmed')
    source_directory, destination = Path(source_directory).resolve(), Path(destination).resolve()
    approved = json.loads((ROOT / 'docs/approved-eating-four-v1.json').read_text(encoding='utf-8'))
    prepared = []
    # Validate every input before touching the active manifest or copying assets.
    for pick in approved['tracks']:
        source = (source_directory / pick['source_file']).resolve()
        if not source.is_relative_to(source_directory) or not source.is_file() or media.sha256(source) != pick['sha256']:
            raise ValueError(f'Approved file missing or changed: {pick["title"]}')
        info = json.loads(media.run(['ffprobe','-v','error','-protocol_whitelist','file,pipe',
                                    '-format_whitelist','mov','-show_streams','-show_format','-of','json',str(source)]))
        if not any(s['codec_type'] == 'audio' for s in info['streams']) or abs(float(info['format']['duration'])-pick['duration']) > .1:
            raise ValueError('Unexpected approved audio duration/format')
        media.run(['ffmpeg','-v','error','-xerror','-protocol_whitelist','file,pipe',
                   '-format_whitelist','mov','-i',str(source),'-f','null','-'])
        url = 'https://www.qishui.com/track/' + pick['track_id']
        credit = (f'{pick["title"]} — {pick["artist"]}\nSource: {url}\n'
                  f'Audio scope: {pick["audio_scope"]}\n'
                  '仅限本地试用：商用及再分发授权待确认。听感确认不是授权证明。\n'
                  'Changes: excerpt/loop, loudness normalization, fades and mix with original eating audio.\n')
        row = {k: pick[k] for k in ('id','title','artist','sha256','duration','audio_scope','style_note')}
        row.update(file=f'{pick["id"]}-{pick["sha256"][:12]}.m4a', source_url=url,
                   license='LOCAL-PREVIEW-ONLY', license_url=url, attribution=credit, enabled=True)
        prepared.append((source, row))
    destination.mkdir(parents=True, exist_ok=True)
    for source, row in prepared:
        target = destination / row['file']
        if target.exists():
            if media.sha256(target) != row['sha256']:
                raise ValueError('Existing content-addressed asset mismatch; not overwritten')
        else:
            shutil.copyfile(source, target)
        if media.sha256(target) != row['sha256']:
            raise ValueError('Copied asset hash mismatch')
    value = {k: approved[k] for k in ('version','usage','commercial_rights','mix_preset','selection_basis','approved_on')}
    value.update(installed_at=datetime.now(timezone.utc).isoformat(), tracks=[row for _, row in prepared])
    manifest = destination / 'library.json'
    temp = destination / f'library.installing-{uuid.uuid4().hex}.json'
    media.write_json(temp, value)
    story_music_library.catalog({'music_library_file': str(temp), 'music_scope':'eating'})
    if manifest.exists():
        backup = destination / f'library.backup-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")}-{uuid.uuid4().hex[:8]}.json'
        shutil.copyfile(manifest, backup)
    temp.replace(manifest)
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-directory', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--local-preview-only', action='store_true', required=True)
    args = parser.parse_args()
    result = install(args.source_directory, args.destination, local_preview_only=args.local_preview_only)
    print(json.dumps({'version':result['version'], 'count':len(result['tracks']),
                      'titles':[r['title'] for r in result['tracks']], 'rights_status':'local_preview_only'}, ensure_ascii=False))
