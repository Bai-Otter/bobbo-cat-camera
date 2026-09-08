# 算法技术参考（开发者）

[返回首页](../README.md) · [系统架构](ARCHITECTURE.md) · [模型和 SDK 安装](DEPENDENCIES.md)

如果只是想了解功能，请先读 [进食识别与吃播是怎么做的](ALGORITHMS.md)。本页保留函数、参数和版本区别，方便开发者查阅。

本文按当前开源源码说明计算路径。常量是代码默认值，不代表所有部署采用同一配置；运行配置、模型和输入也会影响结果。

## 1. 先分清四个问题

| 问题 | 主要证据 | 输出含义 |
| --- | --- | --- |
| 画面里有没有猫？ | 目标检测框与置信度 | 候选观察，不证明进食 |
| 猫是否在碗边进食？ | 碗 ROI、猫脸/姿态/接触证据及时间连续性 | 行为估计，不是食物重量 |
| 这次进食应该如何记账？ | 每秒状态与事件合并规则 | 时长、事件、餐次、覆盖率 |
| 哪些镜头适合吃播？ | 脸大小、朝向、抬头、可见度、连续性 | 高光排序，不是健康评分 |

本项目是**预训练视觉模型 + 可解释规则 + 时间聚合 + 视频剪辑**的组合，不是一个端到端直接输出“吃了多少”的单模型。

## 2. 完整调用关系

```text
移动警报 / 待分析录像
  └─ server/src/feedAnalysis/coordinator.js
       ├─ HLS 回放获取、重试、任务和设备占用协调
       └─ visionWorker.js / visionHttpClient.js
            ├─ 当前路径：vision_worker.py → vision/src/
            └─ 冻结路径：vision_worker_v32.py → vision-v32/src/
                 ↓ 逐帧行为证据
       feedingStats.js → 每秒状态 → 进食事件 → 餐次
                 ↓
       素材保存 → foodcast/automationService.js
                 └─ continuitySelector.js
                      → evaluation/cute_select_cli.py
                      → evaluation/cute_segments.py
                 ↓
       renderer.js → 剪辑、画面处理、BGM → 每日精选
```

### 哪一套运行时实际会执行？

| 层级 | 源码 | 选择方式 |
| --- | --- | --- |
| Node worker 封装 | [visionWorker.js](../server/src/feedAnalysis/visionWorker.js) | `analyzeRecording()` 使用 `fineWorkerScript`；未指定时回落到 `workerScript` |
| HTTP worker 入口 | [visionHttpServer.js](../server/src/feedAnalysis/visionHttpServer.js) | 读取 `FEED_ANALYSIS_WORKER_SCRIPT` 和 `FEED_ANALYSIS_V32_WORKER_SCRIPT` |
| 当前 Python 入口 | [vision_worker.py](../server/src/feedAnalysis/vision_worker.py) | 加载 `vision/src`，支持自适应分析参数 |
| 冻结 Python 入口 | [vision_worker_v32.py](../server/src/feedAnalysis/vision_worker_v32.py) | 默认加载 `vision-v32`；可由 `FEED_ANALYSIS_V32_VISION_ROOT` 指定目录 |
| V3.2 统计 | [feedingStats.js](../server/src/feedAnalysis/feedingStats.js) | `buildFeedingStats()`，版本字段为 `feeding-stats-v3.2` |

**重要：** 统计结果写着 V3.2，不足以证明视觉 worker 使用了冻结 V3.2。要同时检查 worker 脚本、Python 导入目录和模型路径。冻结入口没有透传当前路径的全部自适应参数，因此不能把两者描述为完全相同的执行流程。

## 3. 粗筛与候选区间

源码入口：[vision/src/video.py](../vision/src/video.py)、[detectors.py](../vision/src/detectors.py)、[analyzer.py](../vision/src/analyzer.py)。

当前路径将视频解码、抽样，并对采样图像做猫目标检测。采样结果记录 `offsetSec`、`hasCat`、检测框与置信度；`screenOnly` 路径只做筛查，不应当作完整进食统计。

自适应路径的作用是用稀疏检测缩小需要行为验证的候选范围，同时保留用于验证的图像缓存，避免把一次猫检测当成整段录像的进食判断。`video.py` 的自适应缓存请求解码帧率为 **8 fps**，最大宽度请求为 **640**；这与摄像头回放 **8 倍速**是两个不同概念。具体输入读取还受本地/远程读取实现影响。

候选构造可从 [coordinator.js](../server/src/feedAnalysis/coordinator.js) 的 `buildCandidateRanges()` 阅读：

- 收集 `hasCat === true` 的采样时间；
- 合并相近命中，默认合并间隔为采样间隔的 3 倍；
- 默认向前扩展 8 秒、向后扩展 12 秒，并包含一个采样间隔；
- 裁剪到录像边界，再合并重叠区间。

这些候选区间也用于分析诊断。**生成了候选区间字段，不意味着每个部署都会下载、物理裁剪并逐个重新精筛它们。** 当前协调器把分析请求交给所选 worker，具体是否自适应粗筛/缓存验证由该路径决定。

录像取流使用 HLS，并按配置请求倍速；源码包含较低倍速重试。倍速上限、网络、读取失败、解码和模型计算都会影响总时长，不能承诺“8 倍速 = 8 倍端到端提速”。

## 4. 冻结 V3.2 行为验证

核心文件：[vision-v32/src/feeding_behavior.py](../vision-v32/src/feeding_behavior.py)，相关读取与证据组装在 [video.py](../vision-v32/src/video.py)。冻结说明见 [FROZEN.md](../vision-v32/FROZEN.md)。

这层组合几类证据：

1. **空间关系**：目标框、配置的碗 ROI，以及脸/口鼻与碗的接近或接触关系。
2. **姿态与猫脸**：姿态关键点或猫脸关键点帮助定位口鼻，判断头部方向；近距离、部分脸和普通距离采用不同验证分支。
3. **局部运动**：对口鼻附近图像计算运动证据；部分路径还检查分割接触。它不是逐次咀嚼计数器。
4. **时间组织**：将验证结果映射回录像时间，并处理短暂检测缺失。冻结读取器通常按 0.5 秒生成候选观察，内部验证使用额外帧；不能把输出时间步长当作全部分析帧率。

相关函数包括 `evaluate_pose_evidence()`、`evaluate_face_landmark_contact()`、`evaluate_muzzle_motion()`、`summarize_behavior_second()` 和 `verify_candidate_behavior()`。

输出的 `behaviorEvidence` 中，`faceAtBowl` 与 `eatingVerified` 是不同字段。前者表示脸在碗边接触的证据，后者包含更细的验证组合。**当前 Node 统计的 `eating` 分类主要读取 `faceAtBowl`，不是简单读取 `eatingVerified`。** 因此不应把最终时长宣传为已经逐秒验证了咀嚼动作。

## 5. 从证据到进食记录

入口：[feedingStats.js](../server/src/feedAnalysis/feedingStats.js) 的 `buildFeedingStats({ source, frames, analyzedDurationSec })`。

### 输入和输出

输入 `source` 描述录像身份、时长、方向和时间范围；`frames` 是已分析的时间采样，包含 `offsetSec`/`second`、`hasCat`、`nearBowl`、置信度和 `behaviorEvidence`。

返回：

| 字段 | 含义 |
| --- | --- |
| `summary.actualEatingSeconds` | 按当前分类和平滑规则计入进食的秒数 |
| `summary.bowlPresenceSeconds` | 进食及在碗边但未判为进食的秒数 |
| `summary.mealCount` | 聚合后的餐次数 |
| `summary.coverage` | 有观察证据的时间覆盖比例，不是识别准确率 |
| `timeline` | 压缩后的状态区间，可用于时间轴 |
| `events` / `meals` | 事件与餐次区间，两者不是同一粒度 |
| `diagnostics` | 拒绝原因、状态秒数、平滑补桥记录和阈值 |

### 状态与时间规则

状态包括 `no_cat`、`cat_away_from_bowl`、`near_bowl_not_eating`、`eating`、`uncertain`。未观察时间与明确观察到没有猫不能混为一谈。

统计先形成每秒状态，再进行受条件约束的短缺失补桥和进食访问连续性处理，随后形成事件并聚合餐次。当前常量包括：

| 常量 | 默认值 | 用途 |
| --- | --- | --- |
| `MIN_VERIFIED_EATING_SECONDS` | 3 秒 | 事件有效进食证据门槛 |
| `MIN_FEEDING_EVENT_SPAN_SECONDS` | 7 秒 | 事件跨度门槛 |
| `MAX_FACE_OBSERVATION_GAP_SECONDS` | 2 秒 | 短猫脸观察缺口处理 |
| `MAX_TRANSIENT_EATING_INTERRUPTION_SECONDS` | 1 秒 | 瞬时中断处理 |
| `MAX_FEEDING_VISIT_GAP_SECONDS` | 24 秒 | 带支持证据的访问缺口处理上限 |
| `SAME_MEAL_GAP_SECONDS` | 600 秒 | 同餐聚合使用的间隔参数 |

这些不是“只要间隔小于阈值就无条件填满”的规则，完整条件见对应 `bridge*()`、`buildFeedingEvents()` 与 `groupEventsIntoMeals()`。事件跨度不等于实际进食秒数，合并成一顿也不意味着间隔全算进食。

## 6. 即时开始提醒与历史统计

入口：[feedingStartConfirmation.js](../server/src/feedAnalysis/feedingStartConfirmation.js) 的 `evaluateFeedingStartConfirmation()`；调用和去重调度在协调器。

默认确认条件同时检查：有效进食至少 6 秒、事件跨度至少 8 秒、置信度至少 0.6、进食证据距离分析窗口末尾不超过 5 秒。输出包含 `confirmed`、`reason`、`evidence` 和 `thresholds`。

这里的“5 秒”是**相对分析窗口结束位置**，不是天然等于相对现在的墙钟时间。历史回放也可能在窗口末尾发生进食，因此通知调用方还需要控制任务用途、墙钟时效、去重和冷却。不能仅凭这个函数返回 true 就向用户发送历史进食提醒。

## 7. 贴脸吃播：从一帧好看到一段可看

### 7.1 猫脸特征与分数

[cute_highlights.py](../vision/src/cute_highlights.py) 的 `evaluate_cute_face()` 从猫脸框和关键点提取：脸大小、朝向、抬头程度、可见度、模型置信度，及 `toward_camera`、左右侧脸、低头、看向别处、部分脸等关系标签。

当前 `cuteScore` 的组合为：

```text
0.40 × sizeScore + 0.30 × cameraScore
+ 0.20 × pitchScore + 0.10 × visibilityScore
```

特定无效关系会将该分数置零，再通过置信度、可见度和关系策略门控。

用于选峰的 `positive_rank_score()` 位于 [cute_annotation.py](../vision/evaluation/cute_annotation.py)，权重不同：

```text
0.55 × sizeScore + 0.25 × pitchScore + 0.10 × visibilityScore
+ 0.05 × relationConfidence + 0.05 × modelConfidence
```

**`cuteScore` 与 `rankScore` 不要混用**，两者也都不是经过标定的概率。

### 7.2 连续片段选择

[cute_segments.py](../vision/evaluation/cute_segments.py) 的 `build_cute_segments()`：

1. 规范化并按时间排序输入采样；
2. 用局部中位数等时间处理得到连续性信息，同时保留峰值排名证据；
3. 按排名、猫脸分数、模型置信度和关系门控选择峰；
4. 通过非极大值抑制避免在同一瞬间重复选峰；
5. 向两边扩展为连续片段，限制无猫空隙和坏关系过渡；
6. 合并重叠片段，并在需要时拆分过长片段。

默认目标是每段 **6 秒**，允许 **4–8 秒**，无猫间隙和坏关系过渡各最多 **1 秒**；主要门槛见文件顶部 `DEFAULT_CONFIG`，允许调用方显式传入配置。

Node 桥接器 [continuitySelector.js](../server/src/foodcast/continuitySelector.js) 调用 Python 模块 `evaluation.cute_select_cli`，通过 stdin/stdout 传输 JSON。输入是 `requests: [{ id, frames, durationSec }]`，输出包含 `algorithm: "cute-continuity-v3"`、实际配置及各请求的 `segments`。

### 7.3 全天汇总、时长与音乐

[automationService.js](../server/src/foodcast/automationService.js) 汇总已就绪的每顿素材，必要时补齐猫脸时间轴，调用连续片段选择器：

- 先按素材挑选优质候选，让不同餐次有机会贡献镜头；预算不足时不保证每顿都有镜头；
- 再按候选质量补充，去重后恢复时间顺序；
- `compact` / `standard` / `rich` 的预算为 30 / 60 / 120 秒；
- `auto` 的预算为 `min(120, max(20, readyMealCount × 15))` 秒。

预算是上限，不是强行凑足的成片长度。实际结果取决于有效候选。
最后 [renderer.js](../server/src/foodcast/renderer.js) 负责 FFmpeg 裁切、组合与音频处理；[bgmLibrary.js](../server/src/foodcast/bgmLibrary.js) 管理音乐。每日精选生成路径要求可用 BGM，空音乐库可能返回 `BGM_LIBRARY_EMPTY`。

## 8. 不连接摄像头也能理解接口

### 验证连续片段选择器协议

安装 Python 依赖后，在仓库根目录运行（PowerShell）：

```powershell
$env:PYTHONPATH = "$PWD;$PWD/vision"
'{"requests":[]}' | .venv/Scripts/python -m evaluation.cute_select_cli
```

预期得到 `ok: true`、`algorithm: "cute-continuity-v3"` 和空 `results`。这只是协议冒烟测试，不证明模型效果。

### 分析自己的本地视频

补齐模型后可调用当前运行时 CLI：

```powershell
$env:PYTHONPATH = "$PWD;$PWD/vision"
.venv/Scripts/python -m src.cli analyze --source 'your-video.mp4' --detector-backend yolo --yolo-model 'vision/models/yolo11s.pt'
```

固定碗区域通过 `--bowl-roi` 提供 JSON；应基于实际画面方向标定。这个命令调用 **当前 `vision/src`**，并不等于完整警报调度链路，也不是冻结 V3.2 入口。

## 9. 标注、测试和效果边界

本地 [标注网页](../vision/annotation/README.md) 用于导入视频和时间轴、标记可爱/排除区间并导出 JSON。[cute_annotation.py](../vision/evaluation/cute_annotation.py) 与 `cute_cli.py` 提供评估和参数探索；这些工具不意味着运行中自动在线训练模型。

阅读测试建议：

- [行为验证测试](../vision/tests/test_feeding_behavior.py)：接触、遮挡、近景等边界。
- [统计测试](../server/src/feedAnalysis/feedingStats.test.js)：按秒状态、平滑、事件与餐次。
- [连续片段测试](../vision/tests/test_cute_segments.py)：峰值、扩展、合并、切分。
- [全天吃播测试](../server/src/foodcast/automationService.test.js)：素材、选择、生成与更新流程。

冻结版本不要原地调参。提交算法变更应报告模型版本、输入条件、标注来源、漏检/误检、时间边界误差、素材覆盖与耗时。没有跨猫、跨家庭留出验证时，不宣称普适准确率；没有称重依据时，不输出真实克数。

旧实验记录 [2026-08-22 连续片段 v3](algorithms/2026-08-22-cute-foodcast-continuity-v3.md) 保留当时的状态描述，不作为当前生产接入情况或新环境性能承诺。
