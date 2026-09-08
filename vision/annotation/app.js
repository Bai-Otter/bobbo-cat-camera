(function () {
  "use strict";

  const TAGS = [
    ["closeup", "贴脸"], ["toward_camera", "看镜头"], ["head_up", "抬头"],
    ["eating", "进食"], ["profile", "侧脸"], ["looking_away", "看向别处"],
    ["head_down", "低头"], ["partial", "画面不完整"],
  ];
  const STORAGE_KEY = "bobbo-cute-annotation-v1";
  const state = { video: null, timeline: [], videoId: "", duration: 0, start: 0, end: 0, verdict: "cute", editingIndex: -1, tags: new Set(), dataset: null };
  const $ = (id) => document.getElementById(id);
  const video = $("video");

  TAGS.forEach(([value, label]) => {
    const wrapper = document.createElement("label");
    wrapper.innerHTML = `<input type="checkbox" value="${value}"><span>${label}</span>`;
    wrapper.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.tags.add(value); else state.tags.delete(value);
    });
    $("tagList").appendChild(wrapper);
  });

  function fmt(seconds) {
    const value = Math.max(0, Number(seconds) || 0); const mins = Math.floor(value / 60); const secs = value - mins * 60;
    return `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
  }
  function setStatus(message, type) { $("status").textContent = message; $("status").className = `status ${type || ""}`; }
  function evidence(frame) { return frame && frame.cuteEvidence && typeof frame.cuteEvidence === "object" ? frame.cuteEvidence : (frame || {}); }
  function normalizeFrames(raw) {
    const frames = Array.isArray(raw) ? raw : (raw && (raw.frames || raw.timeline)) || [];
    return frames.map((frame) => {
      const e = evidence(frame); return {
        offsetSec: Number(frame.offsetSec ?? frame.second ?? 0), cuteScore: Number(e.cuteScore || 0), modelConfidence: Number(e.modelConfidence || 0),
        sizeScore: Number(e.sizeScore || 0), cameraScore: Number(e.cameraScore || 0), pitchScore: Number(e.pitchScore || 0), visibilityScore: Number(e.visibilityScore || 0),
        faceRelation: String(e.faceRelation || frame.faceRelation || "unknown"), hasCat: Boolean(frame.hasCat || frame.hasTarget), cuteEligible: Boolean(e.cuteEligible), strictEligible: Boolean(e.strictEligible), looseEligible: Boolean(e.looseEligible),
      };
    }).filter((frame) => Number.isFinite(frame.offsetSec)).sort((a, b) => a.offsetSec - b.offsetSec);
  }
  function currentVideo() { return state.dataset && state.dataset.videos.find((item) => item.id === state.videoId); }
  function ensureDataset() {
    if (!state.dataset) state.dataset = { datasetVersion: 1, videos: [], labels: [] };
    const existing = state.dataset.videos.find((item) => item.id === state.videoId);
    const videoData = { id: state.videoId, name: state.video ? state.video.name : state.videoId, durationSec: state.duration, frames: state.timeline };
    if (existing) Object.assign(existing, videoData); else state.dataset.videos.push(videoData);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.dataset));
  }
  function labelsForCurrent() { return (state.dataset?.labels || []).map((label, index) => ({ ...label, index })).filter((label) => label.videoId === state.videoId); }
  function labelAt(time) { return labelsForCurrent().find((label) => label.startSec <= time && time < label.endSec); }
  function renderTimeline() {
    const track = $("timeline"); track.replaceChildren(); const duration = Math.max(.1, state.duration);
    state.timeline.filter((frame) => frame.cuteEligible || frame.strictEligible || frame.looseEligible).forEach((frame) => {
      const marker = document.createElement("button"); marker.className = "timeline-label candidate"; marker.style.left = `${frame.offsetSec / duration * 100}%`; marker.style.width = `${Math.max(.35, 100 / Math.max(1, state.timeline.length))}%`; marker.title = `${fmt(frame.offsetSec)} · score ${(frame.cuteScore * 100).toFixed(0)}`; marker.onclick = () => seek(frame.offsetSec); track.appendChild(marker);
    });
    labelsForCurrent().forEach((label) => { const marker = document.createElement("button"); marker.className = `timeline-label ${label.verdict}`; marker.style.left = `${label.startSec / duration * 100}%`; marker.style.width = `${Math.max(.5, (label.endSec - label.startSec) / duration * 100)}%`; marker.title = `${fmt(label.startSec)}-${fmt(label.endSec)}`; marker.onclick = () => seek(label.startSec); track.appendChild(marker); });
  }
  function renderLabels() {
    const target = $("labels"); target.replaceChildren(); const labels = labelsForCurrent(); $("labelCount").textContent = `${labels.length} 段`;
    if (!labels.length) { target.innerHTML = '<div class="meta">还没有标注，先在视频上选一段。</div>'; return; }
    labels.forEach((label) => {
      const card = document.createElement("div"); card.className = "label-card"; card.onclick = () => { state.start = label.startSec; state.end = label.endSec; state.verdict = label.verdict; state.editingIndex = label.index; $("startSec").value = label.startSec; $("endSec").value = label.endSec; $("cuteValue").value = label.cuteValue || 3; $("note").value = label.note || ""; state.tags = new Set(label.tags || []); document.querySelectorAll("#tagList input").forEach((input) => { input.checked = state.tags.has(input.value); }); seek(label.startSec); updateVerdictButtons(); };
      const tags = (label.tags || []).slice(0, 3).join(" · ");
      card.innerHTML = `<div><strong>${fmt(label.startSec)} - ${fmt(label.endSec)}</strong><div class="meta">${label.verdict === "cute" ? "可爱" : "排除"} · ${label.cuteValue || 0}/5${tags ? ` · ${tags}` : ""}</div></div><button class="delete" title="删除">删除</button>`;
      card.querySelector(".delete").onclick = (event) => { event.stopPropagation(); state.dataset.labels.splice(label.index, 1); ensureDataset(); renderAll(); };
      target.appendChild(card);
    });
  }
  function renderAll() { renderTimeline(); renderLabels(); $("datasetSummary").textContent = state.dataset ? `${state.dataset.videos.length} 个视频 · ${state.dataset.labels.length} 段标注` : "尚未加载数据集"; }
  function nearestFrame(time) { return state.timeline.reduce((best, frame) => !best || Math.abs(frame.offsetSec - time) < Math.abs(best.offsetSec - time) ? frame : best, null); }
  function updateInspector() {
    const frame = nearestFrame(video.currentTime || 0); if (!frame) return; $("frameRelation").textContent = frame.faceRelation || "unknown";
    $("metrics").innerHTML = [ ["可爱值", frame.cuteScore], ["脸部面积", frame.sizeScore], ["镜头关系", frame.cameraScore], ["抬头", frame.pitchScore], ["置信度", frame.modelConfidence] ].map(([name, value]) => `<span class="metric">${name} <b>${(Number(value || 0) * 100).toFixed(0)}</b></span>`).join("");
    $("currentTime").textContent = fmt(video.currentTime); $("seek").value = video.currentTime || 0; $("rangeHint").textContent = `${fmt(state.start)} - ${fmt(state.end)}`;
  }
  function seek(seconds) { if (!state.duration) return; video.currentTime = Math.max(0, Math.min(state.duration, Number(seconds) || 0)); updateInspector(); }
  function updateVerdictButtons() { document.querySelectorAll("[data-verdict]").forEach((button) => { button.style.outline = button.dataset.verdict === state.verdict ? `2px solid ${button.dataset.verdict === "cute" ? "var(--green)" : "var(--red)"}` : "none"; }); }
  function clearComposer() { state.start = video.currentTime || 0; state.end = Math.min(state.duration, state.start + 1); state.editingIndex = -1; state.verdict = "cute"; state.tags.clear(); $("startSec").value = state.start.toFixed(1); $("endSec").value = state.end.toFixed(1); $("cuteValue").value = "3"; $("note").value = ""; document.querySelectorAll("#tagList input").forEach((input) => { input.checked = false; }); updateVerdictButtons(); updateInspector(); }
  function loadVideoFile(file) { state.video = file; state.videoId = `${file.name}:${file.size}:${file.lastModified}`; video.src = URL.createObjectURL(file); $("videoEmpty").hidden = true; }
  function readJson(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { try { resolve(JSON.parse(reader.result)); } catch (error) { reject(error); } }; reader.onerror = reject; reader.readAsText(file, "utf-8"); }); }
  async function loadFiles() {
    const videoFile = $("videoInput").files[0]; const timelineFile = $("timelineInput").files[0]; if (!videoFile || !timelineFile) { setStatus("请同时选择视频和 timeline.json", "error"); return; }
    try { loadVideoFile(videoFile); state.timeline = normalizeFrames(await readJson(timelineFile)); state.dataset = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || { datasetVersion: 1, videos: [], labels: [] }; video.addEventListener("loadedmetadata", () => { state.duration = video.duration || (state.timeline.at(-1)?.offsetSec || 0); $("duration").textContent = fmt(state.duration); $("seek").max = state.duration; ensureDataset(); renderAll(); clearComposer(); setStatus(`已加载 ${videoFile.name}`, "ok"); }, { once: true }); } catch (error) { setStatus(`加载失败：${error.message || error}`, "error"); }
  }
  function saveLabel() { const start = Number($("startSec").value); const end = Number($("endSec").value); if (!(end > start) || start < 0 || end > state.duration) { setStatus("时间段范围无效", "error"); return; } const labels = labelsForCurrent().filter((label) => label.index !== state.editingIndex); if (labels.some((label) => start < label.endSec && end > label.startSec)) { setStatus("时间段与已有标注重叠", "error"); return; } const value = Number($("cuteValue").value); const item = { videoId: state.videoId, startSec: start, endSec: end, verdict: state.verdict, cuteValue: value, tags: [...state.tags], note: $("note").value.trim(), createdAt: new Date().toISOString() }; if (state.editingIndex >= 0) state.dataset.labels[state.editingIndex] = item; else state.dataset.labels.push(item); ensureDataset(); renderAll(); setStatus("标注已保存", "ok"); clearComposer(); }
  function exportDataset() { if (!state.dataset || !state.dataset.videos.length) { setStatus("还没有可导出的数据", "error"); return; } const blob = new Blob([JSON.stringify(state.dataset, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "bobbo-cute-annotations.json"; link.click(); URL.revokeObjectURL(link.href); setStatus("标注 JSON 已导出", "ok"); }
  async function importDataset(file) { try { state.dataset = JSON.parse(await readJson(file)); const videoData = state.dataset.videos[0]; if (videoData) { state.videoId = videoData.id; state.timeline = normalizeFrames(videoData.frames); state.duration = Number(videoData.durationSec || 0); $("seek").max = state.duration; } localStorage.setItem(STORAGE_KEY, JSON.stringify(state.dataset)); renderAll(); setStatus("标注数据已导入", "ok"); } catch (error) { setStatus(`导入失败：${error.message || error}`, "error"); } }

  $("loadFiles").onclick = loadFiles; $("video").addEventListener("timeupdate", updateInspector); $("seek").oninput = (event) => seek(event.target.value); $("useCurrentStart").onclick = () => { state.start = video.currentTime; $("startSec").value = state.start.toFixed(1); updateInspector(); }; $("useCurrentEnd").onclick = () => { state.end = video.currentTime; $("endSec").value = state.end.toFixed(1); updateInspector(); }; $("markStart").onclick = $("useCurrentStart").onclick; $("markEnd").onclick = $("useCurrentEnd").onclick; $("saveLabel").onclick = saveLabel; document.querySelectorAll("[data-verdict]").forEach((button) => { button.onclick = () => { state.verdict = button.dataset.verdict; updateVerdictButtons(); }; }); $("exportDataset").onclick = exportDataset; $("importDataset").onclick = () => $("datasetInput").click(); $("datasetInput").onchange = (event) => event.target.files[0] && importDataset(event.target.files[0]); window.addEventListener("keydown", (event) => { if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return; if (event.code === "Space") { event.preventDefault(); video.paused ? video.play() : video.pause(); } if (event.key === "[") $("useCurrentStart").click(); if (event.key === "]") $("useCurrentEnd").click(); if (event.key.toLowerCase() === "s") { state.verdict = "cute"; saveLabel(); } if (event.key.toLowerCase() === "x") { state.verdict = "exclude"; saveLabel(); } }); updateVerdictButtons();
})();
