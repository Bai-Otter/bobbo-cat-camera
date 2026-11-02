# 已确认 AI 配置与恢复方法（2026-11-02）

2026-11-03 补充：用户在明确获知明文密钥会进入 Git 历史的风险后，要求直接备份真实 AI 密钥。新增 `confirmed-ai-connection-2026-11-03.json`，仅包含当前 AI 中转连接及其明文密钥，不包含配音密钥或完整账号凭证。下面“密钥未上传”的描述是 11 月 2 日的历史状态，不再代表最新备份。不要将该文件内容贴进日志、公开页面或聊天。运行中的服务仍沿用原本机凭证读取方式，本次备份不会自动改变它。

当前实例：`http://127.0.0.1:8883/daily`，数据目录 `data/daily-photo-gallery`。

## 已核对的公开配置

| 项目 | 值 |
| --- | --- |
| 中转基础地址 | `http://www.llmname.com` |
| 模型 | `gpt-6.1-sol` |
| 接口 | `responses` |
| 请求参数 | `stream=true`、`store=false` |
| 总时限 | 600 秒 |
| 配置来源 | 显式复用本机 Codex provider |
| 客户端兼容标签 | 关闭；最近成功任务的 `client_headers={}` |
| 密钥 | 启动时从已有本机凭证读取，未上传 GitHub |

原中转目前使用 HTTP，传输未加密；这里只记录原来确认可用的地址，不代表推荐 HTTP，也没有擅自改成未经验证的 HTTPS。

## 恢复

将 [已确认配置模板](ai-runtime-confirmed-2026-11-02.env.example) 复制为服务根目录 `.env`。已有 `.env` 时先合并对应字段，不要覆盖其他设置。其他电脑须调整 `MUKBANG_CODEX_HOME`，并自行配置授权凭证；GitHub 备份不包含密钥，不能单靠克隆仓库获得调用权限。

加载器读取该目录现有 `config.toml` 中当前 provider 的地址和接口，从已有凭证读取密钥。模型固定为 `gpt-6.1-sol`；若以后本机 provider 改变，地址也会随之改变，须重新核对公开配置。显式进程环境变量优先于 `.env`。

配音继续使用当前数据目录的 `narration-runtime.json`，详见 [配音配置示例](narration-runtime.example.json)。不要复制 `.env.example` 中关闭配音的选项覆盖已确认配音状态。

启动前只读检查（不发送 AI 或配音请求）：

```powershell
python scripts/check_story_runtime.py --data-dir data/daily-photo-gallery --expected-ai-model gpt-6.1-sol
```

[本机专用重启脚本](../scripts/windows/restart-approved-eating-8883.ps1) 备份了已修复版本，含本机绝对路径；换机器先检查所有路径。它拒绝中断正在生成的任务，只重启核实身份的 8883 实例，并核对 AI 配置、原音色、剧情音乐与四首吃播随机曲库。音乐文件与凭证不在 Git 内，须保留原本机文件。该脚本供用户手动执行，不在本次备份中运行。

## 本次故障与修复

1. 重启丢失临时 AI 环境变量，退回未配置的默认模型：将非密钥设置保存在被 Git 忽略的 `.env`，启动检查增加 AI 与模型验证。
2. Windows PowerShell 5.1 将未标注 charset 的 JSON 中文当作旧编码解码，误报 `voice_label` 改变：重启脚本对响应原始字节明确按 UTF-8 解码，保留原有配置比较，不跳过音色检查。

已在 Windows PowerShell 中只读核对运行实例：AI 已配置、原“咪参考克隆”启用、小剧场 12 首按剧情匹配、吃播 4 首随机。此验证没有发起新的付费生成，不等于新任务端到端生成测试。
