# BOBBO 布卜布卜 · 猫咪进食摄像头

由项目所有者授权公开的完整业务源码快照，包含微信小程序、Node.js 后端、
进食识别与统计、冻结的 V3.2 精筛算法、贴脸片段评分、一键吃播剪辑及标注网页。
这不是之前删除算法的精简公开版。

## 代码范围

| 目录 | 内容 |
| --- | --- |
| `miniprogram/` | uni-app / Vue 小程序，登录、直播、回放、时间轴、通知、吃播、个人页 |
| `server/` | API、设备与权限、移动警报、粗筛/精筛调度、统计、进食通知、素材与吃播服务 |
| `vision/` | 检测、姿态/猫脸推理适配、进食判断、贴脸高光筛选、评估与标注网页 |
| `vision-v32/` | 已冻结的 V3.2 算法源码 |
| `new-frontend/` | 界面原型源码 |
| `public/` | Web 页面入口，厂商播放器另行安装 |

来源版本与逐文件导出清单见 [SOURCE_MANIFEST.json](docs/SOURCE_MANIFEST.json)。
本仓库从该版本创建新的历史，不包含原私有仓库的提交历史、密钥、用户数据或视频。
原开发仓库和线上部署没有被本次公开操作修改。

## 必须单独准备的依赖

**源码完整不等于无需配置即可连接生产设备。** 本仓库不捆绑：

- 杰峰/JLink 小程序 SDK、Web 播放器 SDK：向厂商获取许可版本；
- 第三方模型权重：取得适用授权后放入指定位置；
- BGM 音频：自行提供有授权的音乐；
- 微信/厂商密钥、云账号、数据库、设备注册表、个人视频。

具体路径、模型来源与限制见 [DEPENDENCIES.md](docs/DEPENDENCIES.md)。
推理/评分/剪辑代码没有用占位实现替换，也没有为开源重新调参。

## 本地运行

要求 Node.js 22.5+、Python、FFmpeg；小程序构建使用 HBuilderX 和微信开发者工具。

```powershell
Copy-Item server/.env.example server/.env
npm ci --prefix server
python -m venv .venv
.venv/Scripts/python -m pip install -r vision/requirements.txt
node server/scripts/generate-certs.js
npm start --prefix server
```

先补齐模型/SDK，再配置自己的 `server/.env`、
`miniprogram/config/backend.js`、小程序 AppID 与厂商客户端接入参数。
公开版使用 `touristappid` 与 `api.example.com`，不能直接使用微信真实登录。
不要把生产长期密钥写进小程序；客户端 SDK 的授权方式须与厂商核实。

Dockerfile 保留原有模型校验与加载检查；模型没有补齐时构建会失败，
不会静默下载不同模型或改用另一套算法。
部署脚本需检查并配置自己的实例、域名和环境文件。本仓库没有自动部署到生产的工作流。

## 验证

```powershell
node scripts/test-public.cjs
$env:PYTHONPATH = "$PWD;$PWD/vision"
.venv/Scripts/python -m unittest discover -s vision/tests
```

公开版测试入口明确排除了 7 个生产配置/资产测试文件，不代表完整生产验收。
完整原始测试保留，可用 `node --test server/src/**/*.test.js miniprogram/utils/*.test.js` 运行。
SDK、模型、私人测试素材、原部署文档相关的检查需要单独补齐依赖。
原部署工作流以 `.example` 文件保存在 `docs/deployment/`，不会自动执行。
发布时实际运行结果见 [PUBLICATION_CHECKS.md](docs/PUBLICATION_CHECKS.md)。

## 许可证

项目所有者授权的原创代码采用 MIT，见 [LICENSE](LICENSE)。
第三方组件、模型及运行时依赖保留各自条款，MIT 不替代其许可证。
见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
