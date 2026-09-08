# 本机可爱瞬间标注工具

1. 打开 `index.html`。
2. 选择算法输出目录里的视频，例如 `vertical.mp4`，以及同目录的 `timeline.json`。
3. 在视频时间轴上定位，填写开始/结束时间，选择“可爱”或“排除”，再勾选标签并保存。
4. 点击“导出标注”，得到 `bobbo-cute-annotations.json`。

标注 JSON 可交给评估脚本：

```powershell
python -m vision.evaluation.cute_cli evaluate bobbo-cute-annotations.json --out cute-metrics.json
python -m vision.evaluation.cute_cli tune bobbo-cute-annotations.json --out cute-policy-report.json
```

视频和分析结果只在浏览器本地读取，网页没有网络请求。网页会用 `localStorage` 暂存当前标注，导出的 JSON 才是可迁移的正式数据。
