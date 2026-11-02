# 纯享吃播：10首治愈曲库

> 历史候选方案：用户后续未认可这批听感。当前确认版本为[四首精选随机配乐](approved-eating-music-2026-11-02.md)，请勿把本页十首当作最新验收结果。

## 目标与边界

用户希望吃播看起来可爱、治愈，随机配乐即可。不修改识图、选帧或提示词；不增加视觉或配音API调用。沿用当前页面风格增加试听入口。与小剧场的12首剧情分类曲库独立，不修改已认可的声音、字幕或故事混音。

## 选曲

根据作者官方 `https://incompetech.com/music/royalty-free/pieces.json` 的配器、情绪和速度资料初筛，未将主观听感当作已验收；请用户通过试听页确认。

| 曲目 | 方向 |
| --- | --- |
| Carefree | 尤克里里与钟琴，暖暖日常 |
| Daily Beetle | 音乐盒与玩具钢琴，可爱开饭 |
| Life of Riley | 明亮、满足、惬意 |
| Easy Lemon | 钢片琴与马林巴，轻柔陪伴 |
| Fretless | 尤克里里与音乐盒，甜甜日常 |
| Teddy Bear Waltz | 木管与钟琴，慢悠悠摇摆 |
| Cheery Monday | 轻钢琴和钟琴，开心开饭 |
| Rainbows | 马林巴和尤克里里，清新治愈 |
| Sunshine (version 2) | 慢速钢琴和吉他，午后暖阳 |
| Morning | 古典吉他、竖琴和长笛，安静陪伴 |

前两首同时适合原小剧场池；两个池仍是独立10首/12首配置，不是要求22首互不重复。

## 安装与启用

```powershell
python scripts/install_eating_music.py --destination data/daily-photo-gallery/music-eating
```

运行 `run_daily.py --port 8883 --data-dir data/daily-photo-gallery` 时自动查找该数据目录的 `music-eating/library.json`；不存在则保持原声模式。也可用 `MUKBANG_EATING_MUSIC_LIBRARY` 指定绝对manifest路径；显式配置损坏会明确报错，不偷偷选别的曲库。升级代码后需重启现有进程。

安装器从作者官网取10首原文件，保存许可页证据、曲目元数据与SHA256，每首检查音轨、时长及完整解码，通过后原子发布manifest。音频及私有数据不入Git；脚本和选曲清单入Git。

## 自动流程

1. 原算法产出 `highlights.mp4`，原速原声版保留。
2. 从吃播启用曲目中等概率随机选一首，保存 `eating-music-selection.json`。同任务重试不换曲；独立新任务可重复抽中同一首（非轮播去重）。
3. 音乐名义RMS归一到 -32 dBFS，低于故事 -28 dBFS，峰值上限-10 dBFS；淡入0.7秒、淡出1.4秒。不额外配旁白，保留源音轨与其时间轴。无源音轨的视频只加入BGM，不声称恢复了原声。
4. 视频流直接复制，输出 `highlights-music.mp4`；最长支持120秒。校验视频流摘要不变、时长、音轨时长和全解码。长曲截取/短曲循环只作用于音乐。
5. 成功后结果链接指向混音版；原声下载仍保留。结果中的最终摘要/音轨参数对应混音文件，原声版校验嵌套在 `pre_bgm_validation`。
6. BGM失败仍交付原声版，并显示失败原因、部分完成状态；取消操作继续传播，不被容错吞掉。`eating_bgm` 单独计时，细分准备、混音、校验。

## 页面与授权

- `/eating-music`：10首试听与作者署名。`/music` 保持小剧场曲库。
- `/api/eating-music`：只暴露公开曲目字段，不暴露本地文件路径。
- 手机页/调试页显示实际曲名，不将历史无BGM任务冒充新配乐版。
- 曲目为 Kevin MacLeod / Incompetech，按作者网站 CC BY 4.0 使用；发布需附曲名、作者、来源、许可与修改说明。未购买免署名许可，元数据可能被平台移除，不能代替作品说明。
- 保存 `eating-music-credits.txt` 并写入MP4 comment。

## 无AI试听样片

```powershell
python scripts/preview_eating_music.py <已有任务ID> --data-dir data/daily-photo-gallery
```

使用已有原声吃播，通过同一个吃播混音函数随机配曲，在原任务 `local-postprocess/eating-bgm-<随机ID>/preview.mp4` 新增独立样片。不修改原job/result/历史耗时，不调用识图或TTS。选中曲目的试听卡片出现样片入口。

## 回归检查

覆盖10首随机范围、任务固定、故事与吃播隔离、公开字段、文件访问限制、65秒带声/静音素材、无配音、不改画面、失败保留原声、取消、单次AI计数、单独耗时及页面真实状态。全量Python和前端测试继续覆盖既有故事功能。
