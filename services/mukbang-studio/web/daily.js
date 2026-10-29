"use strict";

(() => {
  const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
  const STATUS_LABELS = { queued: "等待处理", preparing: "整理画面", analyzing: "正在寻找今天的小事", rendering: "剪辑与导出", completed: "本次整理完成", failed: "本次生成未完成", cancelled: "本次已取消", interrupted: "本次已中断" };
  const STAGE_LABELS = { upload: "接收与保存", queue: "等待队列", source_probe: "读取源视频", extract_frames: "提取抽样帧", build_sheets: "拼图排版", prepare_request: "准备 AI 请求", ai_request: "AI 识别", selection: "校验吃播时间轴", story_selection: "校验故事与互动", annotate_sheets: "圈选证据图", render_highlight: "剪辑吃播", render_story: "剪辑人宠小故事", export_memes: "导出表情包", export_posters: "提取真实封面", final_validation: "最终校验", overhead: "其余本地开销" };
  const STAGE_STATES = { running: "进行中", completed: "已完成", failed: "失败", pending: "未执行", skipped: "已跳过", cancelled: "已取消", interrupted: "已中断", unrecorded: "未记录" };

  function safeUrl(value, origin) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const parsed = new URL(value, origin);
      if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      // Media and downloads come only from validated job artifacts, never from
      // an arbitrary same-origin page or API endpoint supplied by model text.
      if (!/^\/api\/jobs\/[0-9a-f]{12}\/files\/.+/.test(parsed.pathname)) return null;
      return parsed.href;
    } catch { return null; }
  }

  function measuredSeconds(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
  function durationLabel(value) {
    const seconds = measuredSeconds(value);
    if (seconds === null) return "--:--";
    const whole = Math.round(seconds);
    return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
  }
  function elapsedLabel(value) {
    const seconds = measuredSeconds(value);
    if (seconds === null) return "未记录";
    if (seconds > 0 && seconds < .01) return "<0.01 秒";
    const rounded = Math.round(seconds * 100) / 100;
    const minutes = Math.floor(rounded / 60);
    const remainder = Number((rounded % 60).toFixed(2));
    return minutes ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
  }

  function generationOptions(values) {
    const options = {
      target_duration: Number(values.target), min_duration: Number(values.min), max_duration: Number(values.max),
      sample_interval: Number(values.interval), story_enabled: true,
      story_target_duration: Number(values.story), story_mode: "inner_monologue", photos_enabled: true, photo_mode: "gallery", use_active_prompt: true
    };
    for (const key of ["target_duration", "min_duration", "max_duration"]) {
      if (!Number.isFinite(options[key]) || options[key] < 1 || options[key] > 120) throw new Error("吃播时长请填写 1–120 秒。 ");
    }
    if (!(options.min_duration <= options.target_duration && options.target_duration <= options.max_duration)) throw new Error("请保持：最短时长 ≤ 吃播目标 ≤ 最长时长。");
    if (!Number.isFinite(options.story_target_duration) || options.story_target_duration < 3 || options.story_target_duration > 60) throw new Error("故事目标请填写 3–60 秒。");
    if (!Number.isFinite(options.sample_interval) || options.sample_interval < .25 || options.sample_interval > 3) throw new Error("抽样间隔请在 0.25–3 秒之间选择。");
    return options;
  }

  function outputsFor(job, origin) {
    const result = job?.result || {};
    const done = TERMINAL.has(job?.status);
    const pending = !job || !done;
    const eatingUrl = safeUrl(result.video_url, origin);
    const story = result.story;
    let eating;
    if (eatingUrl && (!result.highlight_status || result.highlight_status === "ready")) {
      eating = { status: "ready", video_url: eatingUrl, poster_url: safeUrl(result.poster_url, origin), duration: measuredSeconds(result.video_duration), clips: Array.isArray(result.clips) ? result.clips : [], summary: result.summary || "", warnings: result.warnings || [] };
    } else if (pending) eating = { status: "pending" };
    else if (result.highlight_status === "not_found") eating = { status: "not_found", reason: result.highlight_reason || "这段日常没有找到足够合适的吃播画面。没有用无关镜头凑成片。" };
    else eating = { status: "failed", reason: result.highlight_reason || (result.video_url ? "吃播视频地址无效，未展示为已完成。" : "这次尚未得到可播放的吃播成片。") };

    let narrative;
    if (story?.status === "ready") {
      const video = safeUrl(story.video_url, origin);
      narrative = video ? { status: "ready", video_url: video, poster_url: safeUrl(story.poster_url, origin), duration: measuredSeconds(story.video_duration), title: story.title || "今天的小故事", summary: story.summary || "", clips: Array.isArray(story.clips) ? story.clips : [], warnings: story.warnings || [] } : { status: "invalid", reason: "故事视频地址无效，未展示为已完成。" };
      if (video) {
        narrative.has_monologues = story.story_mode === "inner_monologue" && story.validation?.subtitles_burned_in === true;
        narrative.has_narration = story.validation?.narration_added === true;
        narrative.monologues = narrative.has_monologues && Array.isArray(story.inner_monologues) ? story.inner_monologues.filter((cue) => cue && typeof cue.text === "string" && measuredSeconds(cue.output_start) !== null && measuredSeconds(cue.output_end) > cue.output_start) : [];
        narrative.subtitle_url = narrative.has_monologues ? safeUrl(story.subtitle_url, origin) : null;
        narrative.duration_goal = measuredSeconds(story.duration_goal?.target) !== null ? story.duration_goal : null;
        narrative.local_postprocess_kind = story.local_postprocess?.kind;
        narrative.local_postprocess_seconds = ["subtitle_style_only", "subtitle_timing_fix", "paid_breeze_narration"].includes(narrative.local_postprocess_kind) ? measuredSeconds(story.local_postprocess.seconds) : null;
        narrative.postprocess_steps = narrative.local_postprocess_kind === "paid_breeze_narration" && Array.isArray(story.local_postprocess?.steps) ? story.local_postprocess.steps : [];
      }
    } else if (story && ["not_found", "invalid", "failed"].includes(story.status)) narrative = { status: story.status, reason: story.reason || "没有找到人和宠物同镜、真正发生互动的完整小故事。", warnings: story.warnings || [] };
    else if (pending) narrative = { status: "pending" };
    else if (!story && !job?.options?.story_enabled) narrative = { status: "historical", reason: "此历史任务未提取小剧场。原有吃播仍可回看；上传新视频即可同时提取两段。" };
    else narrative = { status: "failed", reason: "本次小剧场尚未生成完成。已完成的吃播不会因此被隐藏。" };
    return { eating, story: narrative };
  }

  function timingRows(timings) {
    if (timings?.schema_version !== 1 || timings.available !== true || !Array.isArray(timings.stages)) return [];
    return timings.stages.filter((stage) => stage && typeof stage === "object").map((stage) => {
      const unmeasured = ["pending", "skipped", "unrecorded"].includes(stage.status);
      return { id: String(stage.id || ""), label: stage.label || STAGE_LABELS[stage.id] || stage.id || "其他环节", seconds: unmeasured ? null : measuredSeconds(stage.seconds), status: STAGE_STATES[stage.status] || "未记录", details: Array.isArray(stage.details) ? stage.details : [] };
    });
  }

  function photosFor(job, origin) {
    const terminal = TERMINAL.has(job?.status);
    function one(category, pick, index = null, count = null) {
      const base = { category, label: category === "portrait" ? "人宠合拍" : index === null ? "丑萌瞬间" : `丑萌瞬间 ${index + 1}/${count}`,
        download_name: index === null ? category : `${category}_${String(index + 1).padStart(2, "0")}` };
      if (pick?.status === "ready") {
        const url = safeUrl(pick.image_url, origin);
        if (!url) return { ...base, status: "invalid", reason: "照片地址无效，未展示为成功。" };
        return { ...base, status: "ready", image_url: url, title: pick.title || base.label, reason: pick.reason || "",
          time: measuredSeconds(pick.source?.source_time ?? pick.time), frame_id: pick.frame_id || "",
          sample_url: safeUrl(pick.sample_url, origin), width: pick.width, height: pick.height, difference: pick.difference || "" };
      }
      if (pick && ["not_found", "invalid", "failed"].includes(pick.status)) return { ...base, status: pick.status, reason: pick.reason || "这类照片未生成。" };
      if (!job) return { ...base, status: "empty", reason: "上传日常，留住一张。" };
      if (!terminal) return { ...base, status: "pending", reason: "正在同一批画面里寻找…" };
      if (!job.options?.photos_enabled) return { ...base, status: "historical", reason: "这条历史记录未提取照片。" };
      return { ...base, status: "failed", reason: "本次照片尚未生成完成。" };
    }
    const all = job?.result?.photos || {}, cute = all.ugly_cute;
    if (Array.isArray(cute?.items) && cute.items.length) {
      return [one("portrait", all.portrait), ...cute.items.map((pick, index) => ({
        ...one("ugly_cute", pick, index, cute.items.length), count_goal: cute.count_goal
      }))];
    }
    return [one("portrait", all.portrait), { ...one("ugly_cute", cute), count_goal: cute?.count_goal }];
  }

  // Pure helpers are exported for deterministic, no-network contract tests.
  if (typeof module === "object" && module.exports) module.exports = { safeUrl, durationLabel, elapsedLabel, generationOptions, outputsFor, photosFor, timingRows };
  if (typeof document === "undefined") return;

  const $ = (id) => document.getElementById(id);
  const origin = window.location.origin;
  const state = { config: null, job: null, jobs: [], file: null, submitting: false, cancelling: false, uncertainUpload: false, pollTimer: null, selectionSequence: 0, historyBusy: false, signatures: {} };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const isRunning = () => Boolean(state.job && !TERMINAL.has(state.job.status));
  const show = (node, visible) => { node.hidden = !visible; };

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options });
    let data;
    if ((response.headers.get("content-type") || "").includes("application/json")) data = await response.json();
    else data = { detail: (await response.text()).slice(0, 400) };
    if (!response.ok) {
      const error = new Error(typeof data.detail === "string" ? data.detail : `请求没有完成（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function formError(message) { $("form-error").textContent = message || ""; show($("form-error"), Boolean(message)); }
  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
  function updateButton() {
    const configured = state.config?.configured === true;
    const supported = state.config?.features?.dual_video === true && state.config?.features?.story_inner_monologue === true && state.config?.features?.photo_gallery === true;
    $("generate-button").disabled = !state.file || !configured || !supported || state.submitting || state.uncertainUpload || isRunning();
    $("generate-button").firstElementChild.textContent = state.submitting ? "正在上传视频…" : state.uncertainUpload ? "提交结果待核对" : isRunning() ? "这次正在生成…" : !state.config ? "正在连接本地服务…" : !configured ? "请先在调试页配置模型" : !supported ? "请启动新版照片相册服务" : "一起生成视频和照片";
    $("cancel-job").disabled = state.cancelling;
    $("cancel-job").textContent = state.cancelling ? "正在取消…" : "取消本次";
    $("video-file").disabled = state.submitting;
    show($("resolve-upload"), state.uncertainUpload);
  }

  function dateLabel(value) {
    const now = new Date();
    const date = value ? new Date(value) : now;
    if (!Number.isFinite(date.getTime())) return "日期未记录";
    const today = date.toDateString() === now.toDateString();
    return `${today ? "今天 · " : ""}${date.getMonth() + 1}月${date.getDate()}日`;
  }
  function historyDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "时间未记录";
  }

  function updatePetName() {
    const name = $("pet-name").value.trim().slice(0, 20) || "小猫";
    $("daily-title").textContent = `${name}的今天`;
    document.title = `${name}的今天 · BOBBO`;
    try { window.localStorage.setItem("bobbo.daily.petName", name === "小猫" ? "" : name); } catch { /* Private browser storage may be disabled. */ }
  }

  function currentOptions() { return generationOptions({ target: $("target-duration").value, min: $("min-duration").value, max: $("max-duration").value, interval: $("sample-interval").value, story: $("story-target").value }); }
  function updateSettingsSummary() { $("settings-summary").textContent = `吃播 ${$("target-duration").value || "—"} 秒 / 故事 ${$("story-target").value || "—"} 秒`; }

  function makeEmpty(kind, output) {
    const isStory = kind === "story";
    const failed = ["failed", "invalid"].includes(output.status);
    const empty = el("div", `empty-media ${isStory ? "story-empty" : "eating-empty"}${output.status === "not_found" || output.status === "historical" ? " no-story" : ""}${failed ? " failed" : ""}`);
    empty.append(el("span", `empty-symbol${isStory ? "" : " bowl-symbol"}`, failed ? "!" : isStory ? "↗" : "⌒"));
    let title;
    let note;
    if (output.status === "historical") { title = "这份记录，还没有小剧场"; note = output.reason; }
    else if (output.status === "not_found") { title = isStory ? "这一段，就留给它自己。" : "这次，还不是吃饭时间。"; note = output.reason; }
    else if (failed) { title = isStory ? "小剧场还没有准备好" : "吃播还没有准备好"; note = output.reason; }
    else if (state.job) { title = isStory ? "找找你们的小小互动…" : "认真吃饭的可爱，正在整理…"; note = "以真实画面为准，合适的片段才会留下。"; }
    else { title = isStory ? "今天，会发生什么小故事？" : "慢慢吃，也慢慢看。"; note = isStory ? "上传一段日常，找找你们的互动。" : "近近的脸、认真吃饭的每一口。"; }
    empty.append(el("p", "", title), el("span", "", note));
    return empty;
  }

  function renderPhotos(job) {
    const picks = photosFor(job, origin), signature = JSON.stringify([job?.id, picks]);
    if (state.signatures.photos === signature) return;
    state.signatures.photos = signature;
    const root = $("photo-outputs"); root.replaceChildren();
    const gallery = job?.options?.photo_mode === "gallery" || Array.isArray(job?.result?.photos?.ugly_cute?.items);
    let shownCount = false;
    picks.forEach((pick) => {
      if (gallery && pick.category === "ugly_cute" && !shownCount) {
        shownCount = true;
        const actual = picks.filter((p) => p.category === "ugly_cute" && p.status === "ready").length;
        root.append(el("p", "photo-gallery-count", `丑萌相册 · ${actual} 张 / 目标至少 4 张`));
        if (pick.count_goal?.met === false) root.append(el("p", "photo-gallery-count", pick.count_goal.shortfall_reason || "当前照片不足4张，未用重复帧凑数。"));
      }
      const card = el("article", "photo-pick"); card.setAttribute("data-category", pick.category);
      if (gallery && pick.category === "portrait") card.classList.add("photo-portrait");
      card.append(el("h3", "", pick.label));
      if (pick.status !== "ready") {
        const empty = el("div", "photo-empty");
        empty.append(el("strong", "", ({ not_found: "没有合适画面", invalid: "选图未通过校验", failed: "未生成", historical: "历史记录", pending: "寻找中", empty: "等待一段日常" })[pick.status]), el("p", "", pick.reason));
        card.append(empty); root.append(card); return;
      }
      const link = el("a", "photo-image-link"); link.href = pick.image_url; link.target = "_blank"; link.rel = "noopener";
      link.setAttribute("aria-label", `查看${pick.label}原图：${pick.title}`);
      const image = el("img"); image.src = pick.image_url; image.alt = `${pick.label}：${pick.title}`; image.loading = "lazy";
      const error = el("p", "", "照片加载失败，可用下方链接下载原图。"); error.hidden = true;
      image.addEventListener("error", () => { image.hidden = true; error.hidden = false; });
      link.append(image); card.append(link, error, el("strong", "", pick.title), el("p", "", `原片 ${elapsedLabel(pick.time)}`));
      const download = el("a", "photo-download", "保存原图 ↗"); download.href = pick.image_url; download.setAttribute("download", `${pick.download_name}.png`);
      card.append(download);
      const details = el("details"); details.append(el("summary", "", "为什么选这张"), el("p", "", pick.reason), el("p", "", `采样 ${pick.frame_id} · ${pick.width} × ${pick.height}`));
      if (pick.difference) details.append(el("p", "", `这张的不同：${pick.difference}`));
      if (pick.sample_url) { const sample = el("a", "", "核对AI看到的采样图 ↗"); sample.href = pick.sample_url; sample.target = "_blank"; sample.rel = "noopener"; details.append(sample); }
      card.append(details); root.append(card);
    });
  }

  function renderOutput(kind, output, job) {
    const root = $(kind === "story" ? "story-output" : "eating-output");
    const signature = JSON.stringify([output, job?.id]);
    if (state.signatures[kind] === signature) return;
    state.signatures[kind] = signature;
    root.replaceChildren();
    if (output.status !== "ready") { root.append(makeEmpty(kind, output)); return; }
    const isStory = kind === "story";
    const stage = el("div", "media-stage");
    const video = el("video");
    video.src = output.video_url;
    video.preload = "metadata";
    video.playsInline = true;
    video.controls = false;
    video.setAttribute("aria-label", isStory ? output.title : "纯享吃播视频");
    if (output.poster_url) video.poster = output.poster_url;
    const shade = el("div", "media-shade media-overlay");
    const duration = el("span", "media-duration media-overlay", durationLabel(output.duration));
    const play = el("button", "play-button media-overlay");
    play.type = "button";
    play.setAttribute("aria-label", isStory ? `播放：${output.title}` : "播放纯享吃播");
    const glyph = el("span", "", "▶"); glyph.setAttribute("aria-hidden", "true"); play.append(glyph);
    stage.append(video, shade, duration);
    if (isStory) {
      const caption = el("div", "media-caption media-overlay");
      caption.append(el("h3", String(output.title).length > 10 ? "long-title" : "", output.title), el("p", "", output.summary));
      stage.append(caption);
    }
    stage.append(play);
    const activate = async () => {
      stage.classList.add("is-playing"); video.controls = true;
      try { await video.play(); } catch { /* Native controls remain available when autoplay is disallowed. */ }
    };
    play.addEventListener("click", activate);
    video.addEventListener("play", () => { stage.classList.add("is-playing"); video.controls = true; });
    video.addEventListener("loadedmetadata", () => { if (output.duration === null && Number.isFinite(video.duration)) duration.textContent = durationLabel(video.duration); });
    const error = el("p", "output-notice", "视频暂时无法加载，可下载后尝试播放。"); error.hidden = true;
    video.addEventListener("error", () => { show(error, true); });
    root.append(stage);
    const foot = el("div", "media-footer");
    const clipCount = output.clips.length;
    foot.append(el("span", "", isStory ? output.has_narration ? "原声＋小布女宝宝配音＋字幕" : output.has_monologues ? "原声＋内心独白字幕" : "原声历史版 · 未加独白字幕" : clipCount ? `${clipCount} 段精选 · ${historyDate(job?.updated_at || job?.created_at)} 更新` : "原速原声 · 慢慢看它吃"));
    const download = el("a", "", "下载视频 ↗"); download.href = output.video_url; download.setAttribute("download", "");
    foot.append(download); root.append(foot, error);
    if (isStory && output.duration_goal) {
      root.append(el("p", "output-notice", `目标 ${output.duration_goal.target} 秒 · 成片 ${output.duration} 秒${output.duration_goal.met === false ? " · 素材不足，未凑时长" : ""}`));
    }
    if (isStory && output.local_postprocess_seconds !== null && output.local_postprocess_seconds !== undefined) {
      const voiced = output.local_postprocess_kind === "paid_breeze_narration";
      const label = voiced ? "另做付费配音与合成" : output.local_postprocess_kind === "subtitle_timing_fix" ? "另做本地字幕时长修正" : "另做字幕排版调整";
      root.append(el("p", "output-notice", `${label}：${elapsedLabel(output.local_postprocess_seconds)}（不计入首次生成耗时；${voiced ? "未重新识图" : "未重新调用 AI"}）`));
      if (voiced) {
        const details = el("details", "output-warnings"); details.append(el("summary", "", "配音与合成耗时明细"));
        (output.postprocess_steps || []).forEach((step) => { if (typeof step.label === "string" && measuredSeconds(step.seconds) !== null) details.append(el("p", "", `${step.label}：${elapsedLabel(step.seconds)}`)); });
        root.append(details);
      }
    }
    if (isStory && output.has_monologues) {
      const details = el("details", "output-warnings");
      details.append(el("summary", "", `小布的内心独白 · ${output.monologues.length} 句（趣味演绎）`));
      output.monologues.forEach((cue) => {
        details.append(el("p", "", `${elapsedLabel(cue.output_start)}—${elapsedLabel(cue.output_end)}　${cue.text}`));
        if (measuredSeconds(cue.source_start) !== null && measuredSeconds(cue.source_end) !== null) details.append(el("small", "", `对应原片 ${elapsedLabel(cue.source_start)}—${elapsedLabel(cue.source_end)}`));
      });
      if (output.subtitle_url) { const link = el("a", "", "下载字幕 SRT ↗"); link.href = output.subtitle_url; link.setAttribute("download", ""); details.append(link); }
      root.append(details);
    }
    const warnings = Array.isArray(output.warnings) ? output.warnings.filter((item) => typeof item === "string" && item.trim()) : [];
    if (warnings.length) {
      const details = el("details", "output-warnings"); details.append(el("summary", "", `查看 ${warnings.length} 条生成说明`));
      warnings.forEach((warning) => details.append(el("p", "", warning))); root.append(details);
    }
  }

  function renderTimings(job) {
    const panel = $("timings-panel"); show(panel, Boolean(job));
    if (!job) return;
    const timings = job.timings;
    const hasTimings = timings?.schema_version === 1 && timings.available === true;
    $("total-time").textContent = hasTimings ? elapsedLabel(timings.total_seconds) : "未记录";
    $("timings-note").textContent = hasTimings ? "从服务收到请求起计；进行中为实时快照，不含网页等待。" : "此历史任务没有完整分环节耗时，不推算、不补成 0 秒。";
    const root = $("timing-list"); root.replaceChildren();
    timingRows(timings).forEach((row) => {
      const item = el("li");
      item.append(el("span", "", row.label), el("strong", "", row.seconds === null ? "—" : elapsedLabel(row.seconds)));
      if (row.status !== "已完成") item.append(el("small", "", row.status));
      root.append(item);
    });
  }

  function renderJob(job) {
    const previousTerminal = state.job && TERMINAL.has(state.job.status);
    state.job = job;
    show($("job-notice"), true);
    $("job-notice").className = `job-notice${["failed", "interrupted"].includes(job.status) ? " is-error" : job.status === "completed" ? " is-complete" : ""}`;
    $("job-stage").textContent = job.stage || STATUS_LABELS[job.status] || "处理中";
    const progress = typeof job.progress === "number" && Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0;
    $("job-percent").textContent = `${Math.round(progress)}%`;
    $("job-progress").setAttribute("aria-valuenow", String(progress)); $("job-progress-fill").style.width = `${progress}%`;
    $("job-message").textContent = job.error || job.message || (job.status === "completed" ? "以实际生成结果为准，没有合格画面会明确留白。" : "等待服务端更新。");
    const calls = job.ai?.call_count;
    $("job-ai-count").textContent = Number.isInteger(calls) && calls >= 0 ? `本次 AI 看图请求：${calls} 次` : "本次 AI 看图请求：未记录";
    show($("cancel-job"), !TERMINAL.has(job.status));
    $("daily-date").textContent = dateLabel(job.created_at);
    const debug = `/?job=${encodeURIComponent(job.id)}`;
    $("prompt-debug-link").href = debug;
    const outputs = outputsFor(job, origin);
    renderOutput("story", outputs.story, job); renderOutput("eating", outputs.eating, job); renderPhotos(job); renderTimings(job);
    renderHistory(); updateButton();
    if (TERMINAL.has(job.status) && !previousTerminal) loadJobs(false);
  }

  function renderHistory() {
    const root = $("history-list"); root.replaceChildren();
    const jobs = state.jobs;
    $("history-note").textContent = jobs.length ? "点开任意一次，回看当时真实生成的内容。" : "还没有生成记录。上传一段日常，开始第一份。";
    jobs.forEach((job) => {
      const item = el("li");
      const button = el("button", `history-button${job.id === state.job?.id ? " is-selected" : ""}`);
      button.type = "button"; button.disabled = state.submitting;
      if (job.id === state.job?.id) button.setAttribute("aria-current", "true");
      button.append(el("strong", "", job.filename || job.id));
      const meta = el("span"); meta.append(el("span", "", historyDate(job.created_at)), el("span", "", STATUS_LABELS[job.status] || "状态未记录")); button.append(meta);
      button.addEventListener("click", () => selectJob(job.id)); item.append(button); root.append(item);
    });
  }

  async function loadJobs(chooseLatest = false) {
    if (state.historyBusy) return;
    state.historyBusy = true; $("refresh-history").disabled = true;
    try {
      const data = await api("/api/jobs");
      state.jobs = Array.isArray(data.jobs) ? data.jobs.filter((job) => job && typeof job.id === "string") : [];
      renderHistory();
      if (chooseLatest && !state.job && state.jobs.length) await selectJob(state.jobs[0].id);
    } catch (error) { $("history-note").textContent = `暂时读不到记录：${error.message}。已有内容仍然保留。`; }
    finally { state.historyBusy = false; $("refresh-history").disabled = false; }
  }

  function schedulePoll(delay = 1200) {
    stopPolling();
    if (!isRunning()) return;
    const id = state.job.id;
    const sequence = state.selectionSequence;
    state.pollTimer = setTimeout(async () => {
      try {
        const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
        if (sequence !== state.selectionSequence || id !== state.job?.id) return;
        renderJob(job); schedulePoll();
      } catch (error) {
        if (sequence !== state.selectionSequence || id !== state.job?.id) return;
        $("job-message").textContent = `暂时读不到进度：${error.message}。只会重读任务状态，不会重发 AI 请求。`;
        if (!error.status || error.status >= 500) schedulePoll(5000);
      }
    }, delay);
  }

  async function selectJob(id) {
    if (state.submitting) return;
    const sequence = ++state.selectionSequence;
    stopPolling();
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
      if (sequence !== state.selectionSequence) return;
      formError(""); renderJob(job); schedulePoll();
      try { const url = new URL(window.location.href); url.searchParams.set("job", job.id); window.history.replaceState(null, "", url); } catch { /* A nonstandard embedded browser may not provide history. */ }
    } catch (error) { if (sequence === state.selectionSequence) formError(`无法载入这次记录：${error.message}`); }
  }

  async function generate(event) {
    event.preventDefault();
    if (state.submitting || state.uncertainUpload || isRunning()) return;
    if (!state.file) { formError("先选择一段视频。"); return; }
    if (!state.config?.configured || !state.config?.features?.dual_video || !state.config?.features?.story_inner_monologue || !state.config?.features?.photo_gallery) { formError("请先确认模型连接和新版合拍＋丑萌相册服务已就绪；可在原调试页检查配置。"); return; }
    let options;
    try { options = currentOptions(); } catch (error) { formError(error.message); $("generation-settings").open = true; return; }
    const file = state.file;
    state.submitting = true; stopPolling(); formError(""); updateButton(); renderHistory();
    const form = new FormData(); form.append("file", file); form.append("options", JSON.stringify(options));
    try {
      const job = await api("/api/jobs", { method: "POST", body: form });
      state.selectionSequence++; renderJob(job); schedulePoll(); await loadJobs(false);
      $("job-notice").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      state.uncertainUpload = !error.status || error.status >= 500;
      formError(state.uncertainUpload ? `上传提交结果尚未确认：${error.message}。不会自动重试，请先刷新生成记录，核对有没有已创建的任务。` : `这次没有提交成功：${error.message}`);
      if (state.uncertainUpload) await loadJobs(false);
    } finally { state.submitting = false; updateButton(); renderHistory(); }
  }

  async function cancelJob() {
    if (state.cancelling || !isRunning()) return;
    const id = state.job.id; const sequence = state.selectionSequence;
    state.cancelling = true; updateButton();
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      if (sequence === state.selectionSequence && id === state.job?.id) { renderJob(job); schedulePoll(); }
    } catch (error) { if (sequence === state.selectionSequence && id === state.job?.id) { $("job-message").textContent = `取消请求尚未确认：${error.message}。已发送的 AI 请求无法撤回，继续核对任务状态。`; schedulePoll(); } }
    finally { state.cancelling = false; updateButton(); }
  }

  function chooseFile() {
    const file = $("video-file").files?.[0];
    state.file = null; formError("");
    if (!file) { $("file-name").textContent = "选择一段视频"; $("file-detail").textContent = "MP4 / MOV / MKV / AVI / WebM / M4V"; updateButton(); return; }
    const maxMB = state.config?.limits?.max_upload_mb || 512;
    if (!/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(file.name)) formError("请选择 MP4、MOV、MKV、AVI、WebM 或 M4V 视频。");
    else if (file.size === 0) formError("这个视频是空文件，请换一段。");
    else if (file.size > maxMB * 1024 * 1024) formError(`视频超过 ${maxMB} MB，先压缩一下再试。`);
    else state.file = file;
    $("file-name").textContent = file.name;
    $("file-detail").textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · ${state.file ? "已选择，尚未上传" : "请更换文件"}`;
    updateButton();
  }

  async function loadConfig() {
    try {
      state.config = await api("/api/config");
      const defaults = state.config.defaults || {};
      [["target-duration", "target_duration"], ["min-duration", "min_duration"], ["max-duration", "max_duration"], ["sample-interval", "sample_interval"]].forEach(([id, key]) => { if (defaults[key] !== undefined) $(id).value = String(defaults[key]); });
      const active = state.config.prompt_library?.active?.id || state.config.prompt_library?.active_version_id;
      $("prompt-standard").textContent = active ? `新生成使用通用提示词 ${active}` : "新生成使用当前通用提示词";
      if (!state.config.configured) formError("模型尚未配置，请打开原调试页完成连接配置。这里不会读取或展示密钥。");
      else if (!state.config.features?.dual_video || !state.config.features?.story_inner_monologue || !state.config.features?.photo_gallery) formError("这个服务尚未加载合拍＋丑萌相册版，请启动新版服务后刷新；旧记录仍可回看。");
      updateSettingsSummary(); updateButton();
    } catch (error) { $("prompt-standard").textContent = "本地服务暂时未连接"; formError(`无法读取配置：${error.message}。请检查服务后刷新页面。`); updateButton(); }
  }

  async function boot() {
    $("daily-date").textContent = dateLabel();
    try { $("pet-name").value = window.localStorage.getItem("bobbo.daily.petName") || ""; } catch { /* Optional local-only preference. */ }
    updatePetName();
    $("upload-form").addEventListener("submit", generate);
    $("video-file").addEventListener("change", chooseFile);
    $("pet-name").addEventListener("input", updatePetName);
    ["target-duration", "min-duration", "max-duration", "story-target", "sample-interval"].forEach((id) => $(id).addEventListener("input", updateSettingsSummary));
    $("cancel-job").addEventListener("click", cancelJob);
    $("refresh-history").addEventListener("click", () => loadJobs(false));
    $("show-history").addEventListener("click", () => { $("history-panel").scrollIntoView({ behavior: "smooth", block: "start" }); $("history-panel").focus({ preventScroll: true }); });
    $("resolve-upload").addEventListener("click", () => { state.uncertainUpload = false; formError("已解除提交保护。仅在确认生成记录里没有本次任务时，再点击生成；不会自动重试。"); updateButton(); });
    await Promise.all([loadConfig(), loadJobs(false)]);
    let requested;
    try { requested = new URL(window.location.href).searchParams.get("job"); } catch { requested = null; }
    if (requested && /^[0-9a-f]{12}$/.test(requested)) await selectJob(requested);
    else if (state.jobs.length) await selectJob(state.jobs[0].id);
  }

  boot();
})();
