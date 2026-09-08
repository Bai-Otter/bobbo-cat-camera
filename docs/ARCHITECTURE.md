# 系统架构

[返回首页](../README.md) · [算法说明](ALGORITHMS.md)

## 组件职责

| 组件 | 入口 | 职责 |
| --- | --- | --- |
| 微信小程序 | [miniprogram/App.vue](../miniprogram/App.vue) | 登录、交互、播放、设置、统计与素材展示 |
| Node API | [server.js](../server/src/server.js)、[routes.js](../server/src/routes.js) | 鉴权、设备权限、API、服务装配 |
| 设备平台适配 | [jf/device.js](../server/src/jf/device.js) | 厂商接口、设备查询、直播与录像控制 |
| 分析调度 | [coordinator.js](../server/src/feedAnalysis/coordinator.js) | 警报/录像分析、重试、取流、时钟和用户回放占用协调 |
| 视觉 worker | [visionWorker.js](../server/src/feedAnalysis/visionWorker.js)、[visionHttpServer.js](../server/src/feedAnalysis/visionHttpServer.js) | 本地 Python 子进程或独立 HTTP 分析服务 |
| 进食统计 | [feedingStats.js](../server/src/feedAnalysis/feedingStats.js) | 证据转时间轴、事件、餐次及统计 |
| 素材与吃播 | [foodcast/automationService.js](../server/src/foodcast/automationService.js) | 每顿素材、全天精选、去重与渲染 |

小程序端不执行 Python 模型推理或服务器 FFmpeg 渲染。摄像头移动警报只是触发信号，不是猫识别结果；设备端识别能力取决于实际硬件/SDK。

## 数据流与存储

```text
设备警报 / 录像目录
  → 分析任务与回放 URL
  → 图像证据
  → 结构化进食结果
  → 每顿原始素材
  → 当天多餐精选
  → 小程序展示 / 下载
```

数据持久化采用代码中的存储适配层，不要求所有部署使用相同存储：

- [appDataStore.js](../server/src/appDataStore.js)：账户和应用数据。
- [feedAnalysis/store.js](../server/src/feedAnalysis/store.js)：分析状态与结果；另有云存储适配。
- [foodcast/materialCatalog.js](../server/src/foodcast/materialCatalog.js)：素材目录。
- [foodcast/store.js](../server/src/foodcast/store.js)、[mediaStorage.js](../server/src/foodcast/mediaStorage.js)：吃播状态与媒体。

分析临时文件、每顿素材和精选成片是不同生命周期。保留时间、清理策略与容量上限需按 `.env.example` 和具体部署配置；开源不包含用户数据库与视频。

## 时间坐标：最容易集成错的部分

1. **设备录像时间**：厂商录像目录与设备时钟使用的时间。
2. **分析偏移**：`offsetSec` 相对本次分析输入开头，不是 Unix 时间戳。
3. **片段/素材偏移**：多个录像区间剪辑后，在输出视频中的位置。

把采样时间转成时间轴要使用正确的录像起点；把高光转回原素材要使用输出映射。倍速取流、裁剪前滚、画面旋转与时钟同步都不能靠修改 UI 时间标签来替代底层映射。

相关入口：[deviceTime.js](../server/src/feedAnalysis/deviceTime.js)、[deviceTimeSync.js](../server/src/feedAnalysis/deviceTimeSync.js)、协调器中的 `trimAnalysisToTargetWindow()` 和吃播服务的素材映射。

## 部署边界

- API 和视觉 worker 可在同机或分机运行；HTTP worker 的授权令牌不应公开。
- HLS 取流请求、解码采样率、模型推理吞吐是三个不同指标。
- 设备通道可能被用户回放占用，后台分析需要暂停/释放/重试，而不是无限开流。
- 生产工作流以 `.example` 保存于 `docs/deployment/`；启用前替换配置并审查权限。
- 模型与厂商 SDK 不在仓库中，参见 [安装指南](DEPENDENCIES.md)。

这份架构说明描述源码职责，不保证所有厂商设备支持相同协议、倍速或并发通道数。
