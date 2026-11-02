# 用户确认的四首吃播配乐

2026-11-02：用户看过同一段40秒吃播分别配四首歌的效果，确认「这次的音乐不错」，要求加入生成流程随机选择。此版本替代先前未通过听感验收的10首吃播候选；不修改小剧场12首剧情匹配曲库、音色、提示词或照片算法。

## 已确认素材

| 曲目 | 作者 | 实际文件时长 | 说明 |
| --- | --- | --- | --- |
| 可爱小孩子 | Regen | 108.016 秒 | 完整音源 |
| 可爱淘气 | 烂番茄气球 | 92.106 秒 | 完整音源 |
| 亿点点偷感（可爱无厘头bgm） | 丢了一个月亮 | 53.475 秒 | 公开试听片段，不是82.896秒整首 |
| ねこふんじゃった（踩到猫了） | Ikuko Sakairi / Noriko Murakami / Shonenshojo Gasshodan Mizuumi | 99.080 秒 | 完整音源 |

精确ID、SHA256和文件名保存于 `approved-eating-four-v1.json`。仅确认这四个具体文件，不自动替换同名曲目。获取时来自平台公开播放响应，没有登录信息、运行时下载依赖或解密步骤；下载地址有时效，不作为部署配置保存。

## 自动生成行为

1. 原吃播算法输出 `highlights.mp4`，保留原声版本。
2. 新任务从这四首里等概率随机抽一首，不调用AI；连续两次可能同曲，不是轮播。
3. `eating-music-selection.json` 固定曲目、版本与混音预设，同任务重试不换歌。旧任务保留原有选曲，旧音源文件不删除。
4. `audition_lufs_v1` 沿用已确认试听：截取所需时长，-28 LUFS双遍归一、音乐峰值目标-9 dBTP、0.4秒淡入/1.2秒淡出，保留原声、不配旁白；最终限幅0.95。超过音乐长度的吃播仅循环音乐，不循环画面。最长120秒沿用既有上限。
5. 不重编码画面，输出 `highlights-music.mp4`。验证视频流摘要、时长、音轨和完整解码。结果显示真实曲名、使用范围与耗时；失败则显示原因并保留原声版，不能冒充已配乐成功。

旧库及小剧场继续使用既有RMS混音；只对新库启用新的LUFS预设。此次变更不触及现有识图Prompt。

## 安装

音源不提交GitHub。准备这四个已验证文件后，在服务根目录执行：

```powershell
python scripts/install_approved_eating_music.py --source-directory "E:/AI/outputs/user-picked-bgm-2026-11-02" --destination "data/daily-photo-gallery/music-eating" --local-preview-only
```

安装器先验证全部源文件的哈希、音轨、实际时长和全解码，再复制为内容寻址文件名，备份旧manifest，最后原子替换 `library.json`。不删除旧音源，不静默覆盖同名但内容不同的文件。不具备这四个文件时不会偷偷下载或换曲。

重启 `run_daily.py --port 8883 --data-dir data/daily-photo-gallery` 后，`/api/eating-music` 应返回4首、`random_per_job`、`cat-eating-approved-four-v1` 和 `local_preview_only`。`/api/music` 仍是12首、`story_mood_per_job`。

已有原声吃播可不花AI费用验证实际混音：

```powershell
python scripts/preview_eating_music.py a0d527770ecb --data-dir data/daily-photo-gallery
```

该脚本使用生产同一混音函数，生成独立对比样片并给选中曲目保存预览入口，不修改原任务成片。`/eating-music` 查看当前库与已有预览，`/daily` 生成新视频。

## 使用范围与回滚

听感通过不等于商业授权。四首均标为 `LOCAL-PREVIEW-ONLY` / `local_preview_only`，仅在本机调试服务启用；未标为CC BY、免版权或商用授权。来源链接不是授权证明。商用及再分发权限仍需另行落实。

GitHub仅保存代码、测试、曲目清单、哈希、制作方法与安装说明；没有媒体文件、用户视频、凭据或临时签名URL。已确认试听页 `127.0.0.1:8893` 继续保留四个40秒成片用于比较。

要恢复旧曲库，先停止生成，再使用 `music-eating/library.backup-*.json` 中明确选定的一份恢复manifest；不要删除音频，因为历史任务仍引用其内容寻址路径。
