"""One isolated paid benchmark: unchanged saved images/Prompt, 1800s timeout."""
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time
import uuid

SERVICE = Path('E:/AI/bobbo-cat-camera-dual-videos/services/mukbang-studio')
DATA = SERVICE / 'data/daily-photo-gallery'
SOURCE_JOB = DATA / 'jobs/e692e554472d'
OUTPUT = Path('E:/AI/outputs/long-cat-benchmark-2026-11-04') / uuid.uuid4().hex[:12]
sys.path.insert(0, str(SERVICE))
os.environ['MUKBANG_APP_DATA_DIR'] = str(DATA)
from mukbang.runtime_config import apply_saved_narration
apply_saved_narration(DATA)
from mukbang.config import ProviderConfig
from mukbang import media, pipeline, vision
from mukbang.timing import JobTimings

OUTPUT.mkdir(parents=True, exist_ok=False)
started = time.monotonic()
state = {'status': 'preparing', 'stage': 'cache_preparation', 'output': str(OUTPUT),
         'source_job_id': SOURCE_JOB.name, 'ai_calls': 0, 'timeout_seconds': 1800}
lock = threading.Lock()
stop_heartbeat = threading.Event()

def record(event, **fields):
    with lock:
        state.update(fields, event=event, elapsed_seconds=round(time.monotonic() - started, 3))
        media.write_json(OUTPUT / 'benchmark-status.json', state)
        print(json.dumps(state, ensure_ascii=False), flush=True)

def heartbeat():
    while not stop_heartbeat.wait(30):
        record('heartbeat')

def read(name):
    return json.loads((SOURCE_JOB / name).read_text(encoding='utf-8'))

def on_timing(snapshot):
    media.write_json(OUTPUT / 'timings.json', snapshot)

timings = JobTimings(on_update=on_timing, scope='cached_input_benchmark',
    note='Same saved 767 frames/13 sheets/Prompt. Reuses source cache; excludes original upload and frame extraction. One AI call; isolated 1800s budget.')
timer_thread = threading.Thread(target=heartbeat, daemon=True)
timer_thread.start()
terminal = 'failed'
key = ''
try:
    with timings.measure('reuse_inputs'):
        original = read('job.json')
        sampling = read('sampling.json')
        prompts = read('prompt.json')
        old_manifest = read('request-manifest.json')
        integrity = read('input-cache-integrity.json')
        for sheet in sampling['sheets']:
            if media.sha256(SOURCE_JOB / sheet['path']) != sheet['sha256']:
                raise ValueError('Original sheet digest mismatch')
        for folder in ('samples', 'sheets'):
            shutil.copytree(SOURCE_JOB / folder, OUTPUT / folder)
        os.link(SOURCE_JOB / 'source.mp4', OUTPUT / 'source.mp4')
        for name in ('source-metadata.json', 'source-pts.json', 'prompt.json', 'sampling.json'):
            shutil.copy2(SOURCE_JOB / name, OUTPUT / name)
        config = ProviderConfig().private()
        key = config['api_key']
        if (config['model'] != old_manifest['model'] or config['api_style'] != old_manifest['api_style']):
            raise ValueError('Provider differs from original benchmark input')
        config['timeout_seconds'] = 1800
        manifest = vision.request_manifest(prompts, sampling['sheets'], config)
        if manifest['images'] != old_manifest['images'] or any(manifest[x] != old_manifest[x] for x in ('system', 'user', 'endpoint', 'client_headers', 'stream', 'store')):
            raise ValueError('Request differs beyond explicitly extended timeout')
        media.write_json(OUTPUT / 'request-manifest.json', manifest)
        record('prepared', sheet_count=len(sampling['sheets']), frame_count=sampling['frame_count'],
               model=config['model'], source_duration_seconds=original['source']['duration'])

    # Add observation only; the normal production transport/body is unchanged.
    original_client = vision.httpx.AsyncClient
    class ObservedClient(original_client):
        def __init__(self, *args, **kwargs):
            async def request_hook(request):
                record('request_send_started', network_started_at=datetime.now().astimezone().isoformat())
            async def response_hook(response):
                record('response_headers_received', response_status=response.status_code,
                       response_headers_at_seconds=round(time.monotonic() - started, 3))
                original_iterator = response.aiter_bytes
                async def observed_iterator(*a, **k):
                    received = 0
                    async for chunk in original_iterator(*a, **k):
                        received += len(chunk)
                        if chunk and 'first_response_byte_at_seconds' not in state:
                            record('first_response_byte', first_response_byte_at_seconds=round(time.monotonic()-started, 3))
                        with lock:
                            state['received_bytes'] = received
                        yield chunk
                response.aiter_bytes = observed_iterator
            kwargs['event_hooks'] = {'request': [request_hook], 'response': [response_hook]}
            super().__init__(*args, **kwargs)
    vision.httpx.AsyncClient = ObservedClient
    record('ai_started', status='analyzing', stage='ai_request', ai_calls=1)
    ai_started = time.monotonic()
    try:
        with timings.measure('ai_request'):
            response = vision.call_vision(prompts, sampling['sheets'], OUTPUT, config)
    finally:
        vision.httpx.AsyncClient = original_client
        state['ai_seconds'] = round(time.monotonic() - ai_started, 3)
    (OUTPUT / 'ai-raw-response.txt').write_text(response['text'], encoding='utf-8')
    media.write_json(OUTPUT / 'ai-response-envelope.json', response['envelope'])
    record('ai_completed', status='rendering', stage='selection', ai_usage=response.get('usage', {}))
    ai = {'model': config['model'], 'provider': config['base_url'], 'api_style': config['api_style'],
          'call_count': 1, 'request_manifest': manifest, 'raw_response': response['text'],
          'usage': response.get('usage', {}), 'elapsed_seconds': state['ai_seconds']}
    with timings.measure('selection'):
        parsed = vision.parse_model_json(response['text'])
        ai['parsed'] = parsed
        media.write_json(OUTPUT / 'ai-selection-original.json', parsed)
        metadata, pts = read('source-metadata.json'), read('source-pts.json')
        points = pts['pts']
        restored = [{'best_effort_timestamp': p,
                     'duration': (points[i+1] if i+1 < len(points) else pts['end_pts'])-p}
                    for i, p in enumerate(points)]
        info = media.video_info(metadata, restored)
        choices = pipeline.validate_decisions(parsed, sampling['frames'], info['duration'], original['options'])
        media.write_json(OUTPUT / 'validated-decisions.json', choices)
    def emit(fields):
        if fields.get('stage'):
            record('render_progress', stage=fields['stage'], progress=fields.get('progress'),
                   message=fields.get('message', ''))
    fields = pipeline.render_choices(OUTPUT, OUTPUT / 'source.mp4', original['options'], info,
        sampling, integrity['source_sha256'], choices, original['source'], prompts, ai,
        emit, lambda: False, timings)
    media.write_json(OUTPUT / 'pipeline-result.json', fields)
    terminal = 'completed'
    record('completed', status='completed', stage='completed')
except BaseException as exc:
    if isinstance(exc, vision.VisionError) and exc.raw_text:
        (OUTPUT / 'ai-raw-response.txt').write_text(vision.redact(exc.raw_text, key), encoding='utf-8')
    record('failed', status='failed', error=vision.redact(str(exc), key), error_type=type(exc).__name__)
finally:
    timings.finish(terminal)
    stop_heartbeat.set()
    record('finished', status=terminal)
