"""Opt-in paid Breeze narration. Text only; credentials never enter artifacts."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import time
import wave

import httpx

from . import media
from .story_subtitles import plain_caption, performance_direction

BASE = "https://api.breeze.blue"
INSTRUCTIONS = "保持这个音色本身的女宝宝声音，轻轻地自言自语，笨笨软软，带一点好奇和馋嘴。自然停顿，不喊叫，不拔高句尾，不用播音腔。"


class NarrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class BreezeConfig:
    api_key: str = field(repr=False)
    voice_id: str
    model_id: str = "breeze-tts-2"
    instructions: str = INSTRUCTIONS
    concurrency: int = 2
    deadline_seconds: float = 120.
    voice_label: str = '小布女宝宝'
    voice_kind: str = 'saved-voice'

    def __post_init__(self):
        if not self.api_key or any(ord(c) < 33 or ord(c) > 126 for c in self.api_key):
            raise NarrationError("Breeze API凭证缺失或格式错误")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", self.voice_id):
            raise NarrationError("Breeze音色ID格式错误")
        if self.model_id not in {"breeze-tts-2", "breeze-tts-2-multilingual"}:
            raise NarrationError("不支持的Breeze模型")
        if not 1 <= self.concurrency <= 4 or not 5 <= self.deadline_seconds <= 300:
            raise NarrationError("Breeze并发或请求时限超出安全范围")

    def payload(self, text, direction=''):
        return {"text": plain_caption(text), "model_id": self.model_id, "language_code": "zh",
                "instructions": self.instructions + performance_direction(direction),
                "voice_settings": {"guidance_scale": 1., "use_speaker_boost": True, "speed": 1., "volume": 1.}}


def enabled() -> bool:
    return os.getenv("MUKBANG_BREEZE_ENABLED", "").lower() in {"1", "true", "yes"}


def configured() -> BreezeConfig:
    key = os.getenv("BREEZE_API_KEY", "").strip()
    if not key:
        key_file = os.getenv("BREEZE_API_KEY_FILE", "")
        try:
            key = Path(key_file).read_text(encoding="utf-8-sig").strip() if key_file else ""
        except OSError:
            raise NarrationError("无法读取本地Breeze凭证文件") from None
    from . import story_profile
    profile = story_profile.load()
    if profile:
        return BreezeConfig(key, profile['voice_id'], instructions=story_profile.VOICE_INSTRUCTIONS,
                            voice_label='已确认的咪参考克隆', voice_kind='authorized-reference-clone')
    return BreezeConfig(key, os.getenv("MUKBANG_BREEZE_VOICE_ID", ""),
                        model_id=os.getenv("MUKBANG_BREEZE_MODEL", "breeze-tts-2"))


def wav_duration(data: bytes) -> float:
    try:
        with wave.open(io.BytesIO(data), "rb") as stream:
            if stream.getnchannels() != 1 or stream.getframerate() != 24000 or stream.getsampwidth() != 2:
                raise ValueError
            frames = stream.getnframes()
            if not 0 < frames <= 24000 * 30 or len(stream.readframes(frames)) != frames * 2:
                raise ValueError
            return frames / 24000
    except (EOFError, ValueError, wave.Error):
        raise NarrationError("配音WAV不完整、格式不符或超过30秒；未采用残缺音频") from None


async def _synthesize(config, cues, directory, cancelled, transport):
    started = time.monotonic()
    directory.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(base_url=BASE, headers={"xi-api-key": config.api_key},
                                 timeout=30., follow_redirects=False, transport=transport) as client:
        try:
            response = await asyncio.wait_for(client.get("/v1/entitlements"), config.deadline_seconds)
            if response.status_code != 200:
                raise NarrationError(f"Breeze订阅核验失败（HTTP {response.status_code}）")
            entitlement = response.json()
        except (httpx.HTTPError, asyncio.TimeoutError, ValueError):
            raise NarrationError("Breeze订阅核验网络错误或返回格式不符") from None
        if entitlement.get("commercial_use_allowed") is not True:
            raise NarrationError("Breeze付费商用订阅尚未生效；未调用生成接口")
        public_entitlement = {key: entitlement.get(key) for key in
                              ("plan_code", "status", "commercial_use_allowed", "current_period_end")}
        gate = asyncio.Semaphore(min(config.concurrency, max(1, int(entitlement.get("max_concurrent_generations", 1)))))
        async def one(index, cue):
            body = config.payload(cue["text"], cue.get('performance_direction',''))
            identity = {"voice_id": config.voice_id, "body": body, "format": "wav_24000", "version": 1}
            digest = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            audio = directory / f"{digest}.wav"
            meta_file = directory / f"{digest}.json"
            if audio.is_file() and meta_file.is_file():
                try:
                    meta = json.loads(meta_file.read_text(encoding="utf-8"))
                    data = audio.read_bytes()
                    if (meta.get("request_sha256") == digest and meta.get("entitlement", {}).get("commercial_use_allowed") is True
                            and meta.get("sha256") == hashlib.sha256(data).hexdigest()):
                        return {**meta, "duration": wav_duration(data), "cache_hit": True,
                                "request_seconds": 0., "first_body_seconds": None, "id": cue["id"],
                                "instructions":body['instructions']}
                except (ValueError, OSError, NarrationError):
                    pass
            async with gate:
                media.check_cancelled(cancelled)
                request_start = time.monotonic()
                first = None
                data = bytearray()
                async def request():
                    nonlocal first
                    async with client.stream("POST", f"/v1/text-to-speech/{config.voice_id}",
                                             params={"output_format": "wav_24000"}, json=body) as response:
                        if response.status_code != 200:
                            # Do not echo provider bodies, request headers, credentials or URLs from errors.
                            raise NarrationError(f"Breeze配音失败（HTTP {response.status_code}），未自动重试")
                        if not response.headers.get("content-type", "").lower().startswith(("audio/", "application/octet-stream")):
                            raise NarrationError("Breeze未返回音频，未采用响应内容")
                        async for chunk in response.aiter_bytes():
                            media.check_cancelled(cancelled)
                            if chunk and first is None:
                                first = time.monotonic() - request_start
                            data.extend(chunk)
                            if len(data) > 2 * 1024 * 1024:
                                raise NarrationError("Breeze单句音频超出大小限制")
                try:
                    await asyncio.wait_for(request(), config.deadline_seconds)
                except (httpx.HTTPError, asyncio.TimeoutError):
                    raise NarrationError("Breeze配音网络错误或请求超时；未自动重试，已成功的句子可复用") from None
                elapsed = time.monotonic() - request_start
                duration = wav_duration(bytes(data))
                # Only publish a complete validated WAV. Failed responses never become cache entries.
                temporary = audio.with_suffix(".wav.part")
                temporary.write_bytes(data)
                temporary.replace(audio)
                meta = {"id": cue["id"], "text": cue["text"], "file": audio.name, "duration": duration,
                        "request_sha256": digest, "sha256": hashlib.sha256(data).hexdigest(),
                        "entitlement": public_entitlement, "created_at": datetime.now(timezone.utc).isoformat(),
                        "request_seconds": elapsed, "first_body_seconds": first, "cache_hit": False,
                        "first_body_note": "同步WAV响应首个非空数据块，含容器头；不是流式首音频TTFA",
                        "instructions":body['instructions']}
                media.write_json(meta_file, meta)
                return meta
        tasks = [asyncio.create_task(one(i, cue)) for i, cue in enumerate(cues)]
        try:
            clips = await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return {"status": "ready", "provider": "BreezeBlue", "voice_id": config.voice_id,
            "voice_label":config.voice_label, "voice_kind":config.voice_kind,
            "model_id": config.model_id, "language_code": "zh", "instructions": config.instructions,
            "entitlement": public_entitlement, "clips": clips, "seconds": time.monotonic() - started,
            "bgm_added": False, "speed": 1., "pitch_shift": False}


def synthesize(config, cues, directory, cancelled=None, *, transport=None):
    if not 1 <= len(cues) <= 12:
        raise NarrationError("配音只接受1–12句稀疏独白")
    for cue in cues:
        plain_caption(cue["text"])
        performance_direction(cue.get('performance_direction',''))
    async def cancellable():
        task = asyncio.create_task(_synthesize(config, cues, Path(directory), cancelled, transport))
        try:
            while not task.done():
                media.check_cancelled(cancelled)
                await asyncio.wait({task}, timeout=.1)
            return await task
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    return asyncio.run(cancellable())


def align_cues(cues, clips, audio_clips):
    if len(cues) != len(audio_clips):
        raise NarrationError("配音句数与字幕不一致")
    boundaries = {clip["id"]: clip["output_end"] for clip in clips}
    output = deepcopy(cues)
    for i, (cue, audio) in enumerate(zip(output, audio_clips)):
        duration = audio["duration"]
        if not math.isfinite(duration) or duration <= 0:
            raise NarrationError("配音时长无效")
        start = cue["output_start"]
        end = max(cue["output_end"], start + duration + .2)
        limit = min(boundaries[cue["clip_id"]], output[i+1]["output_start"] - .6 if i+1 < len(output) else math.inf)
        if end > limit + .001:
            raise NarrationError(f"独白 {cue['id']} 的自然配音放不下当前动作区间；保留字幕版，不裁尾或加速")
        cue.update(output_end=end, audio_duration=duration, original_subtitle_end=cues[i]["output_end"])
        if "source_end" in cue:
            cue["original_source_subtitle_end"] = cue["source_end"]
            cue["source_end"] += end - cues[i]["output_end"]
    return output


def mix_video(video: Path, destination: Path, cues, narration, audio_dir: Path, cancelled=None):
    """Copy the existing video stream; mix full 24k speech with a gently ducked source track."""
    started = time.monotonic()
    before = media.probe(video, cancelled)
    duration = float(before["format"]["duration"])
    args = ["ffmpeg", "-v", "error", "-nostdin", "-y", *media.SAFE_INPUT_OPTIONS, "-i", str(video.resolve())]
    filters, inputs = [], []
    for i, (cue, clip) in enumerate(zip(cues, narration["clips"]), 1):
        audio_file = (audio_dir / clip["file"]).resolve()
        if audio_file.parent != audio_dir.resolve() or not audio_file.is_file():
            raise NarrationError("配音文件不在受控目录")
        if cue["output_start"] + clip["duration"] > duration + .001:
            raise NarrationError("配音超过视频结尾，未截尾")
        args += ["-protocol_whitelist", "file,pipe", "-f", "wav", "-i", str(audio_file)]
        delay = round(cue["output_start"] * 48000)
        filters.append(f"[{i}:a]aresample=48000,adelay={delay}S:all=1[v{i}]")
        inputs.append(f"[v{i}]")
    windows = "+".join(f"between(t,{c['output_start']:.6f},{c['output_start']+a['duration']+.15:.6f})" for c,a in zip(cues,narration["clips"]))
    if any(s["codec_type"] == "audio" for s in before["streams"]):
        filters.append(f"[0:a]aresample=48000,volume='if(gt({windows},0),0.28,1)':eval=frame[original]")
    else:
        filters.append(f"anullsrc=r=48000:cl=mono,atrim=duration={duration}[original]")
    filters.append("[original]"+"".join(inputs)+f"amix=inputs={len(inputs)+1}:duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad,atrim=duration={duration}[mix]")
    args += ["-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac",
             "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", str(destination.resolve())]
    media.run(args, cancelled)
    mix_seconds = time.monotonic() - started
    validation_start = time.monotonic()
    final = media.probe(destination, cancelled, count=True)
    video_before = next(s for s in before["streams"] if s["codec_type"] == "video")
    video_after = next(s for s in final["streams"] if s["codec_type"] == "video")
    audio_after = next(s for s in final["streams"] if s["codec_type"] == "audio")
    for key in ("width", "height", "codec_name", "pix_fmt"):
        if video_before[key] != video_after[key]:
            raise NarrationError("配音合成改变了画面参数")
    if video_before.get("nb_frames") and video_after.get("nb_read_frames") != video_before["nb_frames"]:
        raise NarrationError("配音合成改变了视频帧数")
    if abs(float(audio_after.get("duration", 0)) - duration) > .15:
        raise NarrationError("配音音轨时长不完整")
    if abs(float(final["format"]["duration"]) - duration) > .15:
        raise NarrationError("配音合成改变了视频时长")
    media.run(["ffmpeg", "-v", "error", "-xerror", *media.SAFE_INPUT_OPTIONS, "-i", str(destination.resolve()), "-f", "null", "-"], cancelled)
    return {"narration_added": True, "bgm_added": False, "video_stream_copy": True, "full_decode_pass": True,
            "actual_container_duration_seconds": float(final["format"]["duration"]),
            "audio_sample_rate": int(audio_after["sample_rate"]), "audio_channels": int(audio_after["channels"]),
            "audio_policy": "source audio preserved, ducked to 28% during speech; paid Breeze speech mixed at 48k; no BGM or speech speed/pitch shift",
            "native_audio_sample_rate_preserved": False,
            "bytes": destination.stat().st_size, "sha256": media.sha256(destination),
            "mix_seconds": mix_seconds, "validation_seconds": time.monotonic()-validation_start}
