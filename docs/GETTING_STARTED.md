# 开发者安装指南

[返回功能介绍](../README.md) · [需要准备的文件](DEPENDENCIES.md)

这页供准备安装项目的开发者使用，因此保留必要的命令和配置名称。只想了解产品功能，可以先看首页。

## 快速开始

### 1. 获取源码与运行环境

要求 Node.js **22.5+**、Python（发布测试使用 **3.12**）、FFmpeg。小程序使用 HBuilderX 与微信开发者工具构建。

```powershell
git clone https://github.com/Bai-Otter/bobbo-cat-camera.git
cd bobbo-cat-camera
npm ci --prefix server
python -m venv .venv
.venv/Scripts/python -m pip install -r vision/requirements.txt
```

### 2. 补齐依赖并配置

按 [依赖指南](DEPENDENCIES.md) 安装厂商 SDK、匹配校验值的模型和有授权的音乐。

```powershell
Copy-Item server/.env.example server/.env
```

编辑 `server/.env`，填入自己的微信与设备平台配置，并将 `FEED_ANALYSIS_PYTHON` 指向虚拟环境 Python。小程序需设置自己的 AppID 和 `miniprogram/config/backend.js` 后端地址。公开版使用 `touristappid`、`api.example.com`，不能直接真实登录。

**不要提交 `.env` 或将生产长期密钥放进客户端。** 厂商 SDK 接入授权需按自己的厂商账号配置。

### 3. 启动后端与小程序

```powershell
node server/scripts/generate-certs.js
npm start --prefix server
```

在 HBuilderX 中打开 `miniprogram/`，配置完成后运行到微信开发者工具。没有安装 JLink SDK 时构建会失败；没有模型或设备授权时，相关分析或取流能力不可用。

Docker 构建保留模型校验，需先补齐权重。`docs/deployment/` 的工作流仅为示例，不会自动部署到任何生产环境。

## 测试

```powershell
node scripts/test-public.cjs
$env:PYTHONPATH = "$PWD;$PWD/vision"
.venv/Scripts/python -m unittest discover -s vision/tests
```

发布检查：公开版 Node 测试 **1,096 项通过**，Python 测试 **180 项通过**。公开版入口排除了 7 个生产配置/资产检查文件；原测试仍保留。完整结果和限制见 [发布检查记录](PUBLICATION_CHECKS.md)。这些结果不是识别准确率，也不替代实机验收。
