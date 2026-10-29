# Single-call Head-top Captions Implementation Plan

**Goal:** 在原有一次视觉API中同时得到故事、独白和猫头位置，自动制作头顶综艺字幕，并提供现有35秒样片的对比版。

**Architecture:** 在每条inner_monologue中增加caption_placement和带真实frame_id的归一化猫头框；复用既有拼图和同一POST，不新增检测器或定位请求。确定性本地代码校验坐标、选择整句稳定位置、避边和避开已知猫头区域，然后生成可信ASS。定位不可靠时明确回退安全字幕，不重试视觉API。

**Tech Stack:** 现有Python服务、Pillow、FFmpeg/libass、pytest；不新增依赖。

## 设计取舍

逐帧视觉追踪需要额外模型或调用，且容易晃动；单一全片固定坐标无法适配不同视频。采用同轮API提供每句涉及采样帧的头部框，整句固定于这些框上方的安全位置，句与句可换位置。第一版不声称逐帧跟踪。浅黄色粗字、深色描边、轻微入场缩放；不遮脸、留边，没空间优先侧边，再回退底部。

## Task 1: contract + regression tests

Files: prompts/story-head-caption-system-appendix.txt, mukbang/vision.py, mukbang/head_captions.py, tests/test_head_captions.py.

先测试非法/非有限坐标、错误frame_id、跨片段引用、低置信度、旧任务无定位信息等情况；添加契约并校验，定位失败不能让有效故事失败。运行pytest tests/test_head_captions.py。

## Task 2: production rendering

Files: mukbang/story_subtitles.py, mukbang/daily_outputs.py.

保留经校验的定位字段，按最终字幕时长选择有效锚点；自动排版并写位置审计JSON。只允许程序生成ASS标签，模型只能返回数字框和纯文字。旧任务继续用原字幕。验证头顶/侧边/安全回退、长句换行、边界、无NaN和ASS注入；运行字幕及日常产物回归测试。

## Task 3: one-call audition

File: scripts/audition_head_captions.py.

已有样片的剪辑/台词/音频已确定，本次只用一次API请求给相同字幕补定位信息，调用使用原有3张拼图和相同契约；不手工指定猫头坐标。未来新上传定位字段直接来自初次完整选片响应，不需要这个历史样片迁移步骤。保存请求、原始响应、单次调用计数、定位与渲染耗时。禁止自动重试。

从干净源片按原剪点重烧字幕，再复制已确认成片的配音+BGM音轨，保留旧样片。验收35秒、700帧、音频包哈希一致、完整解码、代表帧查看和服务文件可访问。

## Task 4: handoff

检查在用服务、等待空闲后重启唯一8883服务，使新Prompt生效；不更换默认音色或音乐。通用代码/测试/方法保存Git，视频及私有请求材料不上传。明确区分已实现单次API自动排版与采样无法保证逐帧避挡的边界。
