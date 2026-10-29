# 小布固定音色配音

默认关闭。开启的进程会给小剧场的内心独白加 Breeze TTS 2 配音；吃播、照片和原视觉 Prompt 不改变。发送的只有短句文字，不发送画面或真人声音。仍只有一个小剧场产品，无 BGM。

## 本地配置

在目标服务进程的环境变量中设置（不要给所有旧服务全局开启）：

```text
MUKBANG_BREEZE_ENABLED=1
BREEZE_API_KEY_FILE=绝对路径/专用secrets/breeze-bobbo-tts.key
MUKBANG_BREEZE_VOICE_ID=用户保存的固定音色ID
MUKBANG_BREEZE_MODEL=breeze-tts-2
```

也支持服务目录下被 Git 忽略的 `.env`，以及仅在进程内的 `BREEZE_API_KEY`；优先使用外部文件。不得将密钥写入 Prompt、任务 JSON、日志或提交到 Git。服务只连接固定的官方 HTTPS 地址，不跟随重定向。

## 行为与恢复

- 每批先读取 `/v1/entitlements` 确认 `commercial_use_allowed=true`；仅使用付费期间生成的音频。
- 保持相同 voice_id、中文、自然语速、不升调。最多2路并发且不超过套餐并发；每句120秒总时限；单句最多30秒音频。失败没有自动 POST 重试。
- 每句完整 WAV 验证后才入缓存。缓存按型号、音色、文字、指令、格式/设置索引，并校验音频哈希和生成时的商用权益。
- 固定动作起点，字幕终点至少覆盖真实音频加0.2秒。两句字幕之间至少0.6秒，声音不跨出已批准片段、不截尾、不强制加速。放不下时明确降级到原声字幕版。
- 配音期间原声降到28%，其他时间保留原声。配音混合时视频流直接复制；48k混音、AAC输出。不再声称最终音轨保留源采样率。
- `story_tts` 与 `story_audio_mix` 单独计时；每句 `request_seconds` 为完整响应耗时，`first_body_seconds` 是同步 WAV 首数据块，不等同于实时流式 TTFA。
- `story-narration.json` 保存配音状态与安全参数。API或混音失败保留字幕视频及说明；取消任务会停止未完成请求，不发布残缺声音。

## 给已有成片补配音

```powershell
python scripts/narrate_story.py --job-dir data/daily-photo-gallery/jobs/JOB --story-result data/daily-photo-gallery/jobs/JOB/story-result.json --output-dir data/daily-photo-gallery/jobs/JOB/local-postprocess/breeze-v1
```

输出目录必须是新的任务子目录；不会重跑识图。先验证新成片，再停掉确切的空闲服务进程，用同一命令加 `--publish --port 8883` 发布。发布前核对原记录哈希、备份 job/result/story-result；原片、原AI返回、原Prompt、首次耗时保持不变。输出中另列本次配音各阶段耗时。

## 参考

- https://docs.breezeblue.ai/guides/text-to-speech
- https://docs.breezeblue.ai/api-reference/account/get-account-entitlements
- https://breezeblue.ai/zh/legal/terms

测试：`python -m pytest tests/test_narration.py tests/test_dual_pipeline.py tests/test_timing.py`。真实声音是否符合人物气质仍需用户试听，解码通过不等于主观听感确认。

## 2026-10-29 接入验收

- 已对已有35秒小剧场完成5句付费配音，保留原声、烧录字幕，无BGM；没有再次识图。
- 配音及权益核验12.891秒；字幕视频编码23.469秒；混音1.656秒；完整本地后处理57.515秒，其余主要为输出校验。单句请求约3.36–4.89秒，以2路并发执行，不能把各句耗时相加视为总耗时。
- 每句语音长度2.96、3.20、2.32、2.32、1.84秒，字幕结束点依据完整音频延长，源时间坐标同步更新。未变速、未升调。
- 8883专用进程已开启配音，原视觉连接配置保持一致；原Prompt库和旧任务记录哈希检查不变。演示任务的旧发布记录在其新输出目录的`previous`内保留。
- 本地专用测试密钥设置累计1000积分保护上限；达到上限需在账户中调整或更换专用密钥，失败不会无限重试。实际密钥和固定私有音色ID不随代码提交。
- 后端820项通过、2项跳过；网页37项通过。浏览器实播确认35秒、画面时间前进、音频正常解码、无媒体错误；主观音色由用户试听确认。
