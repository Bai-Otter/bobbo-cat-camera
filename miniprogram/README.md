# BOBBO 微信小程序

基于 uni-app / Vue 的主客户端。项目介绍、算法导航和完整安装流程见 [仓库首页](../README.md)。

## 页面入口

- `pages/today/`：进食数据与每日概览。
- `pages/live/`：设备列表、直播和历史录像。
- `pages/clips/`：每顿素材与每日精选。
- `pages/profile/`：账户、猫咪档案、通知与吃播偏好。

## 配置与运行

1. 按 [依赖指南](../docs/DEPENDENCIES.md) 安装 JLink 小程序 SDK。
2. 配置 `manifest.json`、`project.config.json` 中自己的微信 AppID。
3. 在 `config/backend.js` 设置自己的后端 HTTPS 地址，并在微信后台配置合法域名。
4. 按厂商 SDK 的授权要求配置接入；`main.js` 中的 `YOUR_*` 是占位符，不是可用凭证。
5. 使用 HBuilderX 打开此目录，运行到微信开发者工具，再做真实设备测试。

源码不含生产凭证。不要把微信 AppSecret 或服务器管理凭证放到客户端。
小程序负责交互与展示，Python 视觉识别、Node 统计和 FFmpeg 吃播渲染位于服务器端；详见 [架构](../docs/ARCHITECTURE.md)。
