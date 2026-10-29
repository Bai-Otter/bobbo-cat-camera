# 小剧场随机配乐 · cat-playful-v1

## 用户要求与筛选边界

用户希望至少10首类似参考BGM、适合小猫视频的音乐，用来随机配乐。本版收集12首不同作品，不用同曲变速凑数。初筛依据作者官网配器和情绪介绍，偏轻巧、俏皮、拨弦/木管/小钢琴，少量温柔尤克里里。尚未完成用户主观试听筛选；不能将元数据初筛说成准确听音匹配。原参考曲尚未识别出原作，不声明这些作品就是原曲同系列。

## 12首独立作品

均为Kevin MacLeod，来源为 [Incompetech官方曲库](https://incompetech.com/music/royalty-free/)。下列中文是选曲方向，不是已试听结论。

| 曲名 | 候选方向 |
|---|---|
| Monkeys Spinning Monkeys | 轻巧木管、拨弦、小猫忙活 |
| Fluffing a Duck | 滑稽木管与铜管、笨笨的小动作 |
| Sneaky Snitch | 短促拨弦与双簧管、偷偷凑近 |
| Investigations | 诙谐松散节奏、留出对白空间 |
| Marty Gots a Plan | 拨弦、木管、小算盘 |
| Sneaky Adventure | 拨弦与巴松、小心探索 |
| Hidden Agenda | 短句与停顿、试探 |
| Mister Exposition | 跳跃钢琴、大号、呆萌日常 |
| Plucky Daisy | 摇摇晃晃的小钢琴 |
| Batty McFaddin - Slower | 俏皮钢琴、小喜剧 |
| Carefree | 尤克里里与钟琴、温柔互动 |
| Daily Beetle | 尤克里里、玩具钢琴、开心日常 |

## 许可与署名

2026-10-30查询的作者官网曲目卡片标明 **CC BY 4.0**。[作者许可页](https://incompetech.com/music/royalty-free/licenses/)区分免费署名使用与付费免署名许可。[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)允许商业分享与改编，但要求恰当署名、提供许可链接、标明改动等。不是公有领域或“无条件免版权”，也不保证平台永无自动版权匹配。未购买免署名许可。

- 安装器保存查询当时的官方页面、曲目目录及页面SHA256，具体作品下载链接和音频SHA256见本地 `library.json`。
- 每次混音输出 `story-music-credits.txt`，包含曲名、作者、作品来源、许可URL、裁切/循环/音量调整/混音说明；同时写入MP4 comment元数据。
- 结果页可展开/下载署名。向其他平台发布时，应将署名一并贴入作品说明。**元数据可能被平台移除，不替代发布署名流程。**
- 自动化商业发布系统后续必须携带该署名，或另行购买适用许可；本轮没有实现外部平台自动发布。
- 旧参考分离BGM仍为 `local_preview_only`，保留原文件，不放进这12首曲库。

## 安装与启用

```powershell
python scripts/install_story_music.py --destination data/daily-photo-gallery/music/cat-playful-v1
```

安装器从官网精确匹配作品，保存内容地址化MP3，FFmpeg完整解码，每首成功后才最终发布清单。失败不会发布半套曲库，也不会把音频写进Git。音频不随代码分发；清单、脚本与方法可复现。

在已有服务专属 `story-profile.json` 中添加：

```json
{
  "music_library_file": "E:/AI/bobbo-cat-camera-dual-videos/services/mukbang-studio/data/daily-photo-gallery/music/cat-playful-v1/library.json"
}
```

这是**添加字段**，不是覆盖整个配置。保留已有voice_file及固定音乐字段，使旧部署兼容，授权克隆音色不变。删除music_library_file可明确恢复原固定音乐模式；运行时不会静默回退。

## 正式生成行为

- `story_music.mix` 调用本地选曲，不增加视觉或TTS调用。
- `secrets.choice` 在启用曲目中等概率选择；可能连续抽到同一首，不承诺轮播不重复。
- 混音前写 `story-music-selection.json`，同一任务重试复用同曲、同哈希、同署名；改曲库顺序或禁用曲目不改变已固定任务。新任务（包括新建的恢复任务）有新的选择。
- 文件缺失、哈希改变或清单错误时明确失败，保留配音无BGM版，不偷换歌曲、不使吃播失效。
- 混音维持原参数：约-28dBFS基准，配音时音乐降到35%，提前0.18秒、结束后0.45秒恢复；淡入0.7秒、淡出1.4秒。循环/裁切到视频时长，视频码流复制，完整解码检查。
- `story.bgm` 保存真实曲名、来源、许可、选曲方式、曲库版本和校验结果；`story.validation.bgm_added`为最终是否加乐标志。
- 吃播保持原声，文案、字幕位置、音色与识图Prompt均不变。

## 试听与验证

`/music` 为曲库页，`/api/music`只提供公开字段，`/api/music/{track_id}/audio`只读取清单登记且哈希一致的本地音频；没有任意文件路径入口。原每日页有入口。

```powershell
python scripts/audition_story_music.py --job-dir data/daily-photo-gallery/jobs/9556642c3bc1 --library data/daily-photo-gallery/music/cat-playful-v1/library.json
```

该脚本从无BGM的已配音中间视频制作12个独立对比，保存到 `local-postprocess/music-audition-v1/`，旧任务JSON和原视频不改。不增加视觉/TTS调用。试听是指定曲目的对比，不伪装成12次随机正式生成。

自动测试覆盖固定音乐兼容、任务固定选择、并发同任务、文件损坏/目录越界/重复曲目/未知许可拒绝、API公开字段、音频Range请求、真实混音视频码流不变、署名写入和前端显示。浏览器MCP本轮无法连接Chrome，不能宣称完成浏览器视觉验收；页面行为由离线测试与实际HTTP检查分别验证。

### 本机交付状态（2026-10-30）

- 12首下载并完整解码通过；12段35秒对比样片均完整解码、视频码流一致，额外视觉与TTS调用均为0。
- 后端全量890通过、2跳过；前端包含旧服务回退提示测试。
- 重启操作被执行环境策略拒绝，原8883监听进程未停止，实测 `/api/config` 仍报告旧固定参考BGM。配置文件已增加曲库字段，**不能把已配置写成已在线生效**。
- 重启前可访问 `/static/music.html`：页面在新API不存在（404）时读取本地、Git忽略的 `web/music-catalog.local.json`，明确标“正式随机配乐尚待重启”，仅提供12个真实对比样片。所有12个样片实际Range请求均为206。
- 原 `/daily` 已增加兼容旧实例的静态试听入口。重启后同页优先用 `/api/music`，才显示随机配乐已接入。
- 待用户重启原8883服务后核对 `/api/config` 的 `music_mode=random_per_job`、`music_track_count=12` 和原授权克隆音色；再核对新结果的 `story.bgm.selection_mode`。
