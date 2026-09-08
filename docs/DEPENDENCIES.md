# 单独安装的依赖

## 摄像头 SDK

从设备厂商获得允许你使用的 SDK，将小程序运行文件放入：

- `miniprogram/jlink-wx-sdk/dist/jlink-wx-sdk.js`
- 对应原始许可证/声明文件放在同目录。

Web 播放器文件安装到 `public/player/`，保留厂商目录结构。
不提供假的 SDK 替身；SDK 缺失时小程序构建不能通过。
原 bundle 的 LICENSE.txt 只列出部分依赖声明，尚未确认整个厂商 SDK 的再分发授权，故不上传。

## 模型

保持原文件名和版本，补齐后用 `vision/models/` 下的 SHA256 清单校验：

- `vision/models/yolo11s.pt`：https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s.pt
- `vision/models/vitpose-s-apt36k.onnx`：RTMLib / https://github.com/JunkyByte/easy_ViTPose
- `vision/models/cat-face/cat_face_localizer.tflite`
- `vision/models/cat-face/cat_face_landmarks_full.tflite`：https://github.com/hugocornellier/cat_detection

另有分割回退路径使用 `yolo11s-seg.pt`，见检测器源代码。
这些地址是原项目记录的来源，并非本项目对第三方权重的再授权。
不要用任意同名新版本替换已校验权重后声称效果一致。
本次发布不附权重，也没有修改生产 Docker 的校验行为。

## 音乐

设置 `FOODCAST_BGM_DIR` 到自己的音频目录，参考
`server/bgm-library.example.json` 配置 `library.json`。
也可放在仓库的本地 `bgm/` 目录。音频不提交 Git。
原来使用的歌曲未确认公开再分发权限，不随源码发布。

## 私人数据和部署

数据库、设备序列号注册表、账户信息、标注视频、评估样本、SSH/云密钥和内部运维记录不公开。
旧项目源码里的域名/AppID已换成公开示例；上线前必须替换并配置微信合法域名。
新仓库不接入生产自动部署，避免公开提交影响现有小程序。
