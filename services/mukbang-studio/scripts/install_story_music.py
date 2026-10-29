"""Install an auditable, local CC-BY music pool. No runtime network dependency."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import argparse
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang import media

ORIGIN = 'https://incompetech.com/music/royalty-free/'
LICENSE = 'https://creativecommons.org/licenses/by/4.0/'
PICKS = [
    ('Monkeys Spinning Monkeys', '轻巧木管与拨弦，小猫一本正经地忙活'),
    ('Fluffing a Duck', '滑稽木管与铜管，笨笨的小动作'),
    ('Sneaky Snitch', '短促拨弦与双簧管，偷偷凑近'),
    ('Investigations', '松散诙谐的小节奏，适合留出独白空间'),
    ('Marty Gots a Plan', '拨弦和木管，小猫打着自己的小算盘'),
    ('Sneaky Adventure', '拨弦与巴松，小心翼翼地探索'),
    ('Hidden Agenda', '诙谐的短句与停顿，犹豫和试探'),
    ('Mister Exposition', '跳跃钢琴与大号，呆萌日常'),
    ('Plucky Daisy', '摇摇晃晃的小钢琴，轻松的小步子'),
    ('Batty McFaddin - Slower', '古怪俏皮的钢琴，慢一点的小喜剧'),
    ('Carefree', '尤克里里与钟琴，温柔明亮的互动'),
    ('Daily Beetle', '尤克里里与玩具钢琴，开心的吃饭日常'),
]


def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'BOBBO-music-library/1.0'}), timeout=60) as response:
        return response.read()


def install(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    evidence = destination / 'license-evidence'
    evidence.mkdir(exist_ok=True)
    # Save what was actually checked, not only a claim of permission.
    pages = {name: fetch(url) for name, url in {
        'catalog-page.html': ORIGIN + 'index.html',
        'licensing.html': ORIGIN + 'licenses/',
        'cc-by-4.0.html': LICENSE,
        'pieces.json': ORIGIN + 'pieces.json',
    }.items()}
    if b'Attribution 4.0' not in pages['catalog-page.html'] or b'commercially' not in pages['cc-by-4.0.html']:
        raise ValueError('Official license text changed: review before installing')
    for name, content in pages.items():
        (evidence / name).write_bytes(content)
    catalog = json.loads(pages['pieces.json'])

    def download(pick):
        title, note = pick
        matches = [p for p in catalog if p['title'] == title]
        if len(matches) != 1:
            raise ValueError(f'Exact catalog entry missing/ambiguous: {title}')
        row = matches[0]
        ident = row['isrc'].lower()
        url = ORIGIN + 'mp3-royaltyfree/' + quote(row['filename'])
        filename = ident + '.mp3'
        path = destination / filename
        payload = fetch(url)
        digest = hashlib.sha256(payload).hexdigest()
        # Content-addressed names let existing jobs retain their exact track.
        filename = f'{ident}-{digest[:12]}.mp3'
        path = destination / filename
        if not path.exists():
            path.write_bytes(payload)
        elif media.sha256(path) != digest:
            raise ValueError('Existing audio hash mismatch')
        info = json.loads(media.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)]))
        duration = float(info['format']['duration'])
        if duration < 60 or not any(s['codec_type'] == 'audio' for s in info['streams']):
            raise ValueError(f'Unexpected music duration/format: {title}')
        media.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'])
        source = ORIGIN + 'index.html?isrc=' + row['isrc']
        credit = (f'"{title}" — Kevin MacLeod (incompetech.com)\n'
                  f'Source: {source}\nLicensed under Creative Commons Attribution 4.0: {LICENSE}\n'
                  'Changes: excerpted/looped as needed, volume adjusted, faded and mixed with dialogue/source audio.\n')
        print(f'Validated: {title} ({duration:.1f}s)', flush=True)
        return {'id': ident, 'title': title, 'artist': 'Kevin MacLeod', 'file': filename,
                'sha256': digest, 'duration': duration, 'source_url': source, 'download_url': url,
                'license': 'CC-BY-4.0', 'license_url': LICENSE, 'attribution': credit,
                'style_note': note, 'bpm_publisher': row['bpm'], 'enabled': True}

    with ThreadPoolExecutor(max_workers=3) as pool:
        tracks = list(pool.map(download, PICKS))
    value = {'version': 'cat-playful-v1', 'checked_at': datetime.now(timezone.utc).isoformat(),
             'license_evidence': {name: hashlib.sha256(body).hexdigest() for name, body in pages.items()},
             'selection_basis': 'Publisher instrumentation/mood metadata; subjective match to reference awaits user audition.',
             'tracks': tracks}
    temporary = destination / 'library.installing.json'
    media.write_json(temporary, value)
    temporary.replace(destination / 'library.json')
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    install(args.destination)
