# Mi Production Integration Implementation Plan

**Goal:** 把已认可的咪内心话、授权克隆、参考BGM、额头字幕真正接入8883新上传流程，而非独立试听脚本。

**Architecture:** 同一视觉请求附加通用咪风格与近脸互动审美；新增受控逐句演绎字段。服务数据目录的私有story-profile.json绑定已保存音色文件和音乐文件/哈希，代码不携带私有素材。生成器逐句配音后混入轻BGM，结果记录实际生效版本与声音状态；任一步失败明确显示，不偷偷换音色。其他服务无配置时保留旧音频行为。

**Tech Stack:** 现有Python/httpx/FFmpeg/pytest/原生JS；不新增模型调用轮数或外部依赖。

1. tests/test_story_profile.py、tests/test_narration.py：配置来源、私有信息不公开、演绎传递和缓存隔离测试，先验证失败。
2. mukbang/story_profile.py、narration.py：实现服务专属配置；同轮performance_direction经校验进入逐句TTS请求。
3. prompts/story-mi-style-reference-v1.txt、story-inner-monologue-system-appendix.txt、vision.py：启用角色风格、近脸小反应和审美选片规则，不改吃播P0004和同镜证据约束。
4. mukbang/story_music.py、daily_outputs.py、timing.py：受控本地BGM循环/电平/闪避/完整校验与独立计时，任何音乐错误保留配音版并显示警告。
5. server.py、web/daily.js：显示新生成预设及每条成片的实际音色/BGM/风格，历史记录不冒充新版。
6. 将本地授权克隆和已认可试听音乐写入该服务私有配置；验证哈希、源片与旧结果不变后重启专用服务。
7. 完整离线回归后，通过正式上传接口跑同一源片一次（一次视觉请求和必要文字TTS），检查成片、API轨迹、BGM与音色元数据和样片。保留旧任务，保存方法到GitHub功能分支。

## 完成与验收

- 正常上传任务d7fc4cb2b148已完整成功，单次视觉请求、已确认克隆、5句自动独白、BGM与额头字幕；不是独立试听替换。
- 857 Python通过/2跳过，94前端通过；旧任务与P0004哈希不变。
- 生产预设保存在服务私有data目录，正常重启即可继续使用。原声配音阶段与最终BGM阶段分别记账。
- QA记录首句定位偏低这一残余视觉估计限制；未用单视频手工坐标掩盖它。详见docs/mi-production-profile-2026-10-29.md。
