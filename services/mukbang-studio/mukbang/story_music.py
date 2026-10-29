"""Mix a pinned local music bed, never fetched or selected by the model."""
from array import array
import json
import math
from pathlib import Path
import sys
import time
import wave

from . import media


def mix(video, destination, cues, profile, cancelled=None):
    started = time.monotonic()
    video, destination = Path(video), Path(destination)
    music = Path(profile['music_file'])
    if not music.is_file() or media.sha256(music) != profile['music_sha256']:
        raise ValueError('BGM文件缺失或与已确认版本不一致；未自动替换音乐')
    audio_input = ['-protocol_whitelist','file,pipe','-format_whitelist','wav,mp3,flac,ogg,mov']
    music_info = json.loads(media.run(['ffprobe','-v','error',*audio_input,'-show_streams','-show_format',
                                       '-of','json',str(music.resolve())],cancelled))
    if not any(s['codec_type']=='audio' for s in music_info['streams']):
        raise ValueError('BGM文件没有音轨')
    before = media.probe(video, cancelled)
    duration = float(before['format']['duration'])
    if not 0 < duration <= 60.15:
        raise ValueError('BGM仅用于60秒以内小剧场')
    decoded = destination.parent / 'story-music-normalization.wav'
    media.run(['ffmpeg','-v','error','-nostdin','-y','-stream_loop','-1',*audio_input,
               '-i',str(music.resolve()),'-t',str(duration),'-vn','-ar','48000','-ac','2','-c:a','pcm_s16le',str(decoded)], cancelled)
    with wave.open(str(decoded),'rb') as f:
        values = array('h',f.readframes(f.getnframes()))
    if sys.byteorder != 'little':
        values.byteswap()
    rms = math.sqrt(sum(v*v for v in values)/max(1,len(values))) / 32768
    peak = max((abs(v) for v in values),default=0)/32768
    if rms < 1e-7 or peak == 0:
        raise ValueError('BGM为空白，未发布为已加入音乐')
    gain = min(10**(-28/20)/rms, 10**(-10/20)/peak)
    expression = '1'
    windows = []
    for cue in cues:
        if not cue.get('audio_duration'):
            continue
        start, end = float(cue['output_start']), float(cue['output_start'])+float(cue['audio_duration'])
        if not all(math.isfinite(x) for x in (start,end)) or not 0 <= start < end <= duration+.01:
            raise ValueError('BGM闪避时间无效')
        activity = f'min(clip((t-({start-.18:.6f}))/.18,0,1),clip(({end+.45:.6f}-t)/.45,0,1))'
        expression = f'min({expression},1-.65*{activity})'
        windows.append({'start':start,'audio_end':end,'music_gain_during_voice':.35})
    prep_seconds = time.monotonic()-started
    mix_start = time.monotonic()
    graph = (f"[1:a]volume='{gain:.10f}*{expression}':eval=frame,afade=t=in:d=0.7,"
             f"afade=t=out:st={max(0,duration-1.4):.6f}:d=1.4[music];"
             '[0:a]aformat=sample_rates=48000:channel_layouts=stereo[base];'
             '[base][music]amix=inputs=2:normalize=0:duration=first,'
             'alimiter=limit=0.8414:level=false:latency=true[mix]')
    media.run(['ffmpeg','-v','error','-nostdin','-y',*media.SAFE_INPUT_OPTIONS,'-i',str(video.resolve()),
               '-protocol_whitelist','file,pipe','-i',str(decoded.resolve()),'-filter_complex',graph,
               '-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-ar','48000','-b:a','192k',
               '-t',str(duration),'-movflags','+faststart',str(destination.resolve())],cancelled)
    mix_seconds = time.monotonic()-mix_start
    check_start = time.monotonic()
    final = media.probe(destination,cancelled)
    if abs(float(final['format']['duration'])-duration)>.1:
        raise ValueError('BGM合成改变了视频时长')
    audio = next(s for s in final['streams'] if s['codec_type']=='audio')
    if abs(float(audio.get('duration',0))-duration)>.15:
        raise ValueError('BGM音轨时长不完整')
    def video_hash(path):
        return media.run(['ffmpeg','-v','error',*media.SAFE_INPUT_OPTIONS,'-i',str(path.resolve()),
                          '-map','0:v:0','-c','copy','-f','hash','-hash','sha256','-'],cancelled).strip()
    if video_hash(video) != video_hash(destination):
        raise ValueError('BGM合成改变了视频流')
    media.run(['ffmpeg','-v','error','-xerror',*media.SAFE_INPUT_OPTIONS,'-i',str(destination.resolve()),'-f','null','-'],cancelled)
    return {'status':'ready','bgm_added':True,'label':profile['music_label'],
            'rights_status':profile['music_rights'],'music_source_sha256':profile['music_sha256'],
            'nominal_rms_dbfs':-28,'gain':gain,'speech_duck_windows':windows,
            'video_bitstream_unchanged':True,'full_decode_pass':True,
            'actual_container_duration_seconds':float(final['format']['duration']),
            'audio_sample_rate':int(audio['sample_rate']),'audio_channels':int(audio['channels']),
            'audio_policy':'source + confirmed speech + pinned local BGM; music ducked to 35% during speech',
            'native_audio_sample_rate_preserved':False,'native_audio_channels_preserved':False,
            'bytes':destination.stat().st_size,'sha256':media.sha256(destination),
            'steps_seconds':{'prepare_music':prep_seconds,'mix':mix_seconds,'validation':time.monotonic()-check_start},
            'seconds':time.monotonic()-started}
