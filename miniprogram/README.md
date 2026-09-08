# 猫饭日记·摄像头小程序

PetBuddy 宠物碗架摄像头配套微信小程序，支持配网、实时视频、SD卡回放。

## 项目结构

`
cat-camera-remote/
├── server/          # Node.js 后端（WebRTC/HLS 观看页，已废弃或作为备用）
├── miniprogram/     # 微信小程序（主项目）
│   ├── pages/
│   │   ├── index/       # 设备列表（首页）
│   │   ├── login/       # 微信登录
│   │   ├── bind/        # 配网/添加设备
│   │   └── live/        # 实时视频 + 回放
│   ├── jlink-wx-sdk/    # 杰峰小程序 SDK
│   ├── utils/           # 工具函数
│   ├── common/          # 公共模块（二维码等）
│   └── static/          # 静态资源
└── README.md
`

## 技术栈

- **uni-app** (Vue2)
- **jlink-wx-sdk** (杰峰微信小程序 SDK)
- **目标平台**: 微信小程序

## 核心功能 (MVP)

1. **微信一键登录** - 无感登录，体验最佳
2. **设备列表** - 查看已绑定设备及在线状态
3. **设备配网** - 蓝牙配网 / 二维码配网 / 手动添加
4. **实时视频** - RTMP 低延迟播放，支持对讲、抓图
5. **SD卡回放** - 按日期查看录像并播放

## 快速开始

### 1. 安装 HBuilderX

下载地址: https://www.dcloud.io/hbuilderx.html

### 2. 打开项目

在 HBuilderX 中打开 miniprogram/ 目录

### 3. 运行到微信开发者工具

- 点击「运行」→「运行到小程序模拟器」→「微信开发者工具」
- 首次需要配置微信开发者工具路径

### 4. 真机预览（视频功能必须）

- 微信开发者工具模拟器无法播放真实视频流
- 点击「预览」生成二维码，用手机微信扫码
- 在手机上测试实时视频、回放等功能

## 配置

### AppID

在 manifest.json 中已配置:

``json
\"mp-weixin\": {
  \"appid\": \"touristappid\"
}
``

### 杰峰凭证

在 main.js 中已配置（复用 server/.env 中的凭证）:

``javascript
{
  uuid: 'YOUR_VENDOR_UUID',
  appKey: 'YOUR_VENDOR_APPKEY',
  appSecret: 'YOUR_VENDOR_APPSECRET',
  movedCard: 4
}
``

## 开发注意事项

1. **live-player 组件** - 需要在微信小程序后台开通该组件权限
2. **真机调试** - 视频播放必须真机预览，模拟器不渲染
3. **域名配置** - 生产上线前，在微信小程序后台添加 \pi-cn.jftechws.com\ 为合法域名

## 参考资料

- [jlink-wx-sdk Demo](https://gitee.com/jftek/jlink-wx-sdk-demo)
- [jlink-wx-sdk 文档](https://gitee.com/jftek/jlink-wx-sdk)
- [uni-app 官方文档](https://uniapp.dcloud.io/)
- [微信小程序 live-player](https://developers.weixin.qq.com/miniprogram/dev/component/live-player.html)

## License

MIT
