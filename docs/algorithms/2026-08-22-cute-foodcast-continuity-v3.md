# 可爱吃播连续片段算法 v3

**状态：** 实验基线，已完成一段独立录制的泛化试跑；尚未接入生产 quick-cut。

**代码入口：** `vision/evaluation/cute_segments.py`、`vision/evaluation/render_cute_overlay.py`

## 目标

从固定碗内摄像头的进食录像中找出“猫脸足够大、朝向镜头、没有明显低头或看向别处”的可爱瞬间，并把单帧峰值扩展成可观看的连续片段。算法输出的是候选排序信号，不是经过标定的概率，也不直接做健康诊断。

## 原理

1. **逐帧证据。** 复用 YOLO 猫检测和 CatFLW 猫脸/关键点结果，计算脸部占画面比例、朝向镜头程度、抬头程度、可见度、模型置信度和关系类别。
2. **可爱排序。** `positive_rank_score` 使用可解释加权：`sizeScore 0.55`、`pitchScore 0.25`、`visibilityScore 0.10`、`relationConfidence 0.05`、`modelConfidence 0.05`。排序分数只负责找峰值，不被连续性平滑覆盖。
3. **关系门控。** `toward_camera` 和可靠的左右侧脸可以成为候选；`head_down`、`looking_away`、`partial` 不能成为峰值。短暂坏关系最多作为 1 秒过渡。
4. **时间平滑。** 对相邻样本取短窗口中位数，并保留原始峰值，生成 `continuityScore`。相邻猫脸证据之间的短暂分析空洞允许插值，但不会跨越长时间无猫。
5. **峰值到片段。** 先按 `anchorRankMin=0.65`、`anchorCuteMin=0.55`、`anchorModelConfidenceMin=0.65` 选非极大值峰；从峰值向两侧扩展，目标 6 秒，允许范围 4–8 秒。扩展只接受有效猫脸上下文，最多 1 秒坏关系和 1 秒无猫间隙；相邻候选再合并，过长结果按低谷拆分。
6. **吃播生成。** 按原时间顺序硬切候选片段，保留原始进食声，不叠加框、分数、字幕、BGM 或 Logo。带框版本只用于人工验收。

## 当前配置

```json
{
  "anchorRankMin": 0.65,
  "anchorCuteMin": 0.55,
  "continuityMin": 0.45,
  "minSegmentSec": 4.0,
  "targetSegmentSec": 6.0,
  "maxSegmentSec": 8.0,
  "maxGapSec": 1.0,
  "maxTransitionSec": 1.0,
  "nmsRadiusSec": 1.5,
  "modelConfidenceMin": 0.55,
  "anchorModelConfidenceMin": 0.65
}
```

## 已验证结果

### 基准录像

- 规格：120 秒、竖屏化后的固定碗机位、240 个 0.5 秒样本。
- SHA-256：`333910003A2998432AF748B4953A8980BCB7745B6CF96E5E73006DFF6EAD7F2D`
- 片段：`16.25–20.25`、`33.75–38.25`、`67.75–71.75`、`91.25–95.75`、`107.25–111.25`、`115.25–119.75`。
- 合计：6 段、25.5 秒；每段 4–4.5 秒。

### 独立录制泛化试跑

- 输入：`aab155786b3c3384eb3d47ae49da2943_raw.mp4` 前 120 秒，原始 2558×1440 带旋转元数据，分析时按 1440×2558 竖屏读取。
- 输入 SHA-256：`785F24F49AA8A9B89A77DE7509676526E05622DFB40DDE6476512AF5D721B4D9`
- 片段：`21.75–25.75`、`36.75–41.25`、`51.75–56.75`、`60.25–67.25`、`101.25–105.25`。
- 合计：5 段、24.5 秒；单段 4–7 秒；无猫间隙 0 秒；坏关系过渡 4 秒。
- 峰值排序范围：最高 `0.9261`，最低入选峰值 `0.6569`。
- 输出成片：本机 `.tmp/cute-generalization-20260822/foodcast-generalization-clean.mp4`，24.5 秒，H.264/AAC，1440×2558，约 34.9 MB；输出不纳入 Git。

这次只证明**同一设备/同一只猫的独立录制会话泛化**。没有跨猫、跨家庭或跨机位样本，不能据此宣称跨域泛化能力。

## 复现与验收

从仓库根目录执行，必须同时提供根目录和 `vision` 的 Python 路径：

```powershell
$env:PYTHONPATH = "$PWD;$PWD\vision"
python -m unittest discover -s vision/tests -v
```

当前结果：`151/151` 通过。

泛化试跑命令：

```powershell
$env:PYTHONPATH = "$PWD;$PWD\vision"
python -m evaluation.render_cute_overlay `
  --source 'E:\xwechat_files\wxid_example\msg\video\2026-08\aab155786b3c3384eb3d47ae49da2943_raw.mp4' `
  --output '.tmp\cute-generalization-20260822\annotated-120s.mp4' `
  --report '.tmp\cute-generalization-20260822\analysis-report.json' `
  --model "$PWD\vision\models\yolo11s.pt"
```

用 `ffprobe` 检查输出时长、视频/音频流和尺寸，再用 `ffmpeg -f null -` 完整解码；人工检查带框联系图和干净成片的切点，确认没有黑帧、空段或错误方向。

## 风险与下一步

- 目前阈值和权重来自少量人工标注与两次录制验证，仍需更多猫、设备和光照条件的留出集。
- “可爱”是内容筛选目标，不等同于“正在进食”；生产接入时必须继续沿用进食行为证据的独立门控。
- 接入生产 quick-cut 前，应先补充跨猫留出集、输出片段去重/总时长策略、失败回退和 Node 端接口测试；本实验不改变生产逻辑。
