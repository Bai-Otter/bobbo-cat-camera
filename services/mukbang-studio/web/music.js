"use strict";
(async () => {
  const status = document.getElementById("music-status");
  const root = document.getElementById("music-tracks");
  const el = (tag, text, className) => {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
  };
  try {
    let response = await fetch("/api/music", { cache: "no-store" });
    // Older running servers can serve static auditions before a restart.
    if (response.status === 404) response = await fetch("/static/music-catalog.local.json", { cache: "no-store" });
    if (!response.ok) throw new Error("曲库暂不可用，请确认安装及配置。");
    const pool = await response.json();
    status.textContent = pool.mode === "preview_only" ? `${pool.count} 首可试听 · 正式生成随机配乐尚待重启服务` : pool.count ? `${pool.count} 首已接入 · 本地随机 · 不增加 AI 调用` : "此服务尚未启用随机曲库。";
    const mode = document.getElementById("music-mode");
    if (mode) mode.textContent = pool.mode === "preview_only" ? "下面是已验证的35秒对比样片。当前运行中的服务仍用旧固定BGM，重启后才启用随机曲库。" : "新小剧场随机选一首，同一任务固定不换曲。配音响起时，音乐会轻下来；吃播仍是原声。";
    pool.tracks.forEach((track, i) => {
      const card = el("article", "", "music-track");
      card.append(el("span", String(i + 1).padStart(2, "0"), "track-number"), el("h2", track.title), el("p", track.style_note));
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "none"; audio.volume = 0.35;
      audio.setAttribute("aria-label", `试听 ${track.title}`);
      if (/^\/api\/music\/[a-zA-Z0-9_-]+\/audio$/.test(track.audio_url)) audio.src = track.audio_url;
      audio.addEventListener("play", () => root.querySelectorAll("audio,video").forEach(other => { if (other !== audio) other.pause(); }));
      audio.addEventListener("error", () => { if (!card.querySelector(".audio-error")) card.append(el("p", "此曲暂时无法播放，请刷新后重试。", "audio-error")); });
      const source = el("a", "作者官网 / 许可来源 ↗");
      if (track.source_url.startsWith("https://incompetech.com/")) source.href = track.source_url;
      source.target = "_blank"; source.rel = "noopener noreferrer";
      const credit = el("details"); credit.append(el("summary", "查看发布署名"), el("pre", track.attribution));
      if (audio.src) card.append(audio);
      card.append(source, credit); root.append(card);
      if (typeof track.preview_url === "string" && /^\/api\/jobs\/[a-f0-9]{12}\/files\/local-postprocess\/[a-zA-Z0-9_/-]+\/preview\.mp4$/.test(track.preview_url)) {
        const preview = el("details"); preview.append(el("summary", "看这首配到小剧场的效果"));
        const video = document.createElement("video"); video.controls = true; video.preload = "none"; video.playsInline = true; video.src = track.preview_url;
        video.style.width = "100%"; video.style.marginTop = "14px";
        video.addEventListener("play", () => root.querySelectorAll("audio,video").forEach(other => { if (other !== video) other.pause(); }));
        preview.append(video); card.append(preview);
      }
    });
  } catch (error) { status.textContent = error.message || "读取曲库失败，请刷新后重试。"; }
})();
