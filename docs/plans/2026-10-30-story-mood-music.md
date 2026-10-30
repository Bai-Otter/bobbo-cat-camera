# Story Mood Music Implementation Plan

**Goal:** 给已获用户认可的12首BGM标注可解释的情绪标签，在原一次视觉请求中识别实际选出的小剧场类别，本地在匹配曲目内随机选择。

**Architecture:** Git版本化的策划标签表（5类、多标签、0–3适配分）；独立Prompt附录仅用于内心独白小剧场。模型只返回类别、理由、置信度和原片证据，不返回歌名/路径。非关键分类字段缺失或不可靠不拖垮视频，明确降级到轻松日常。任务首次选曲后固定全部分类/匹配元数据，历史随机任务保持原曲。

**Tech Stack:** Python / existing prompt builder / FastAPI / vanilla JS / pytest + node tests。沿用当前工作树，不开子代理，不新增外部服务。

## 取舍

- 采用5类策划标签 + 类内随机，避免全库盲选；不需要训练模型。
- 不让模型直接推荐歌名：无法限制实际可用曲目，也不利于解释和版权管理。
- 不增加第二轮看图或按每句独白换BGM：保持一轮API、单段音乐与现有时长/音色/字幕。

## 步骤

1. `prompts/story-music-tags-v1.json`：12首按稳定ISRC标注温馨亲昵/warm、呆萌搞笑/funny、好奇试探/sneaky、小小得意/proud、轻松日常/relaxed；这些是产品策划标签，不伪称作者官方分类。
2. `mukbang/story_mood.py`、`tests/test_story_mood.py`：先写缺失/无效/低置信度/片外证据/安全降级测试，再实现验证与最高适配候选选择。
3. `prompts/story-music-mood-v1.txt`、`vision.py`、`story.py`：同一返回对象增加`interaction_story.music_mood`，先原选片再为该故事分类，不改吃播、照片或独白规则。保存到story-decision/story-result。
4. `story_music_library.py`、`story_music.py`、`daily_outputs.py`：正式入口传入验证后的类别，记录候选、匹配分、理由与标签版本；重试复用pin，老pin向后兼容。曲库无合适歌时明确不加BGM，不能悄悄跨类别抽歌。
5. `web/music.*`、`web/daily.js`：每首显示中文标签，生成结果显示类别→曲目及理由/降级；旧服务静态试听也更新标签，但不冒称后端已上线。
6. 运行新单测、整套pytest、node测试；本地无网络合成验证正式参数传递，不额外计费看图/TTS。核对服务真实版本，若重启仍受环境限制则明确交付边界。提交并同步原功能分支。
