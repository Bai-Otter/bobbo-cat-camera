"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { config: null, file: null, job: null, legacy: null, mode: "empty", tab: "highlight", circled: true, evidenceMode: "selected", pollTimer: null, polling: false, submitting: false, toastTimer: null, promptDirty: false, sourceVideo: null, sectionSignatures: {}, drafts: new Map(), iterations: new Map(), dialogSheet: null, inspectedFrame: null, revisionBusy: false,
    promptMode: "custom", jobs: [], promptLibrary: null, libraryLoading: false, libraryMessage: "", libraryError: false, standardDraft: null, libraryMutation: null, libraryBusy: false, libraryConflict: false, activationTarget: null, promptSources: new Map(), sourceBusy: false, proposal: null, proposalTimer: null, proposalPending: null, proposalBusy: false, proposalMessage: "", proposalError: false,
    satisfiedRound: null, candidateReviewedId: null, candidateConflict: false, proposalReadSequence: 0 };
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
  const statusNames = { queued: "等待处理", preparing: "整理画面", analyzing: "AI 正在看图", rendering: "剪辑与导出", completed: "已完成", failed: "生成失败", cancelled: "已取消", interrupted: "已中断" };
  const timingStageDefinitions = [
    ["upload", "接收与保存"], ["queue", "等待队列"], ["source_probe", "读取源视频"],
    ["extract_frames", "提取抽样帧"], ["build_sheets", "拼图排版"], ["prepare_request", "准备 AI 请求"],
    ["ai_request", "AI 识别"], ["selection", "验证选帧与时间轴"], ["annotate_sheets", "圈选证据图"],
    ["render_highlight", "渲染精选"], ["export_memes", "导出表情包"], ["final_validation", "最终校验"], ["overhead", "其余本地开销"]
  ];
  const timingStageStatuses = { pending: "未执行", running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", skipped: "已跳过", unrecorded: "未记录" };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function append(parent, ...children) { children.filter(Boolean).forEach((child) => parent.append(child)); return parent; }
  function show(node, visible) { node.hidden = !visible; }
  function formatSeconds(value, digits = 1) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits).replace(/\.0$/, "") : "—"; }
  function timecode(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--:--";
    const safe = Math.max(0, number);
    const minutes = Math.floor(safe / 60);
    const seconds = (safe % 60).toFixed(digits).padStart(digits ? digits + 3 : 2, "0");
    return `${String(minutes).padStart(2, "0")}:${seconds}`;
  }
  function spanTime(start, end) { return `${timecode(start)}–${timecode(end)}`; }
  function jsonText(data) { try { return typeof data === "string" ? data : JSON.stringify(data, null, 2); } catch { return String(data); } }
  function safeUrl(value) {
    if (!value || typeof value !== "string") return null;
    try { const url = new URL(value, window.location.origin); return url.origin === window.location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  function link(label, url, className = "text-button", download = false) {
    const target = safeUrl(url);
    if (!target) return null;
    const node = el("a", className, label); node.href = target;
    if (download) node.setAttribute("download", "");
    return node;
  }
  function makeButton(label, className, handler) { const button = el("button", className, label); button.type = "button"; button.addEventListener("click", handler); return button; }
  function toast(message) { clearTimeout(state.toastTimer); $("toast").textContent = message; show($("toast"), true); state.toastTimer = setTimeout(() => show($("toast"), false), 4200); }
  function formError(message) { $("form-error").textContent = message || ""; show($("form-error"), Boolean(message)); }
  function notice(message, success = false) { $("notice-banner").textContent = message || ""; $("notice-banner").classList.toggle("success", success); show($("notice-banner"), Boolean(message)); }
  function recoverySource(job) { return job?.recovery?.source_job_id || job?.ai?.reused_response_from_job || null; }
  function isRecovery(job) { return Boolean(recoverySource(job)) || job?.recovery?.no_ai_calls === true; }
  function recoveryMessage(job) { return `复用已有 AI 结果，本次未调用 AI。原任务：${recoverySource(job) || "未记录"}。`; }

  function measuredSeconds(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
  function formatElapsed(value) {
    const seconds = measuredSeconds(value);
    if (seconds === null) return "未记录";
    if (seconds > 0 && seconds < .01) return "<0.01 秒";
    const hundredths = Math.round(seconds * 100);
    if (!Number.isFinite(hundredths)) return "未记录";
    const hours = Math.floor(hundredths / 360000);
    const minutes = Math.floor((hundredths % 360000) / 6000);
    const remainder = Number(((hundredths % 6000) / 100).toFixed(2));
    if (hours) return `${hours} 小时 ${minutes} 分 ${remainder} 秒`;
    if (minutes) return `${minutes} 分 ${remainder} 秒`;
    return `${remainder} 秒`;
  }
  function hasTimings(job) { return job?.timings?.schema_version === 1 && job.timings.available === true; }
  function oldAiSeconds(job) { return !isRecovery(job) && !hasTimings(job) && job?.status === "completed" ? measuredSeconds(job.ai?.elapsed_seconds) : null; }
  function resetTimingsPanel() { $("timings-panel").replaceChildren(); show($("timings-panel"), false); delete state.sectionSignatures.timings; }
  function timingsDownload(job) { return hasTimings(job) && typeof job.id === "string" && job.id ? `/api/jobs/${encodeURIComponent(job.id)}/files/timings.json` : null; }
  function renderTimings(job) {
    const panel = $("timings-panel"); panel.replaceChildren(); show(panel, true);
    const header = el("div", "timings-heading"); const title = el("div");
    append(title, el("p", "eyebrow", "TIME, ACCOUNTED FOR"), el("h3", "", "本次耗时")); header.append(title);
    if (!hasTimings(job)) {
      panel.className = "timings-panel timings-unavailable";
      panel.append(header, el("p", "timings-note", isRecovery(job) ? "此恢复记录未包含完整本地耗时；不会使用来源任务的 AI 时间补算。" : "历史任务未记录完整耗时；新生成任务会分环节统计。"));
      const previousAi = oldAiSeconds(job);
      if (previousAi !== null) panel.append(el("p", "timings-old-ai", `AI 调用（旧记录）：${formatElapsed(previousAi)}。仅这一项有记录，不能据此补出总耗时。`));
      return;
    }
    const timings = job.timings;
    const recordStatus = { running: "进行中 · 服务端快照", completed: "已完成", failed: "失败 · 耗时已保留", cancelled: "已取消 · 耗时已保留", interrupted: "已中断 · 部分记录" };
    const recordState = Object.hasOwn(recordStatus, timings.status) ? timings.status : "unknown";
    panel.className = `timings-panel timings-${recordState}`;
    const total = el("div", "timings-total"); append(total, el("span", "timings-total-label", recordState === "running" ? "目前总耗时" : "总耗时"), el("strong", "", formatElapsed(timings.total_seconds)));
    const actions = el("div", "timings-actions"); append(actions, el("span", "timings-state", `${recordStatus[timings.status] || "已记录"}${timings.is_partial && recordState !== "interrupted" ? " · 部分记录" : ""}`), link("下载耗时 JSON ↗", timingsDownload(job), "text-button tiny", true));
    append(header, total, actions); panel.append(header);
    const stages = Array.isArray(timings.stages) ? timings.stages.filter((stage) => stage && typeof stage === "object") : [];
    const knownIds = new Set(timingStageDefinitions.map(([id]) => id));
    const allStages = timingStageDefinitions.map(([id, label]) => stages.find((stage) => stage.id === id) || { id, label, seconds: null, percent: null, status: "unrecorded" });
    allStages.push(...stages.filter((stage) => !knownIds.has(stage.id)));
    const rows = el("ol", "timings-stages"); rows.setAttribute("aria-label", "各环节实际耗时与占比");
    allStages.forEach((stage) => {
      const stageStatus = Object.hasOwn(timingStageStatuses, stage.status) ? stage.status : "unrecorded";
      const notExecuted = ["pending", "skipped", "unrecorded"].includes(stageStatus);
      const seconds = notExecuted ? null : measuredSeconds(stage.seconds);
      const percent = !notExecuted && typeof stage.percent === "number" && Number.isFinite(stage.percent) && stage.percent >= 0 && stage.percent <= 100 ? stage.percent : null;
      const row = el("li", `timing-stage-row timing-stage-${stageStatus}`); row.dataset.stageId = String(stage.id || "");
      const name = el("div", "timing-stage-name"); append(name, el("strong", "", stage.label || timingStageDefinitions.find(([id]) => id === stage.id)?.[1] || String(stage.id || "未命名环节")), el("span", "timing-stage-state", timingStageStatuses[stageStatus]));
      const bar = el("div", "timing-stage-bar"); bar.setAttribute("aria-hidden", "true"); const fill = el("span"); fill.style.width = `${percent ?? 0}%`; bar.append(fill);
      const ratio = el("span", "timing-stage-percent", percent === null ? "—" : `${Number(percent.toFixed(1))}%`);
      const duration = el("span", "timing-stage-duration", seconds === null ? "—" : formatElapsed(seconds));
      duration.title = seconds === null ? notExecuted ? timingStageStatuses[stageStatus] : "此环节未记录有效耗时" : `${seconds} 秒，${timingStageStatuses[stageStatus]}`;
      append(row, name, bar, ratio, duration);
      const details = Array.isArray(stage.details) ? stage.details.filter((detail) => detail && typeof detail === "object" && !Array.isArray(detail)) : [];
      if (details.length) {
        const group = el("div", "timing-details");
        const list = el("ol", "timing-stage-details"); list.setAttribute("aria-label", "本环节内部耗时细项，不额外相加");
        group.append(el("p", "timing-detail-note", "以下细项已包含在本环节耗时中，不额外相加。"), list);
        details.forEach((detail) => {
          const detailStatus = Object.hasOwn(timingStageStatuses, detail.status) ? detail.status : "unrecorded";
          const unexecuted = ["pending", "skipped", "unrecorded"].includes(detailStatus);
          const detailSeconds = unexecuted ? null : measuredSeconds(detail.seconds);
          const item = el("li", `timing-detail-row timing-detail-${detailStatus}`); item.dataset.detailId = String(detail.id || "");
          const detailName = el("div", "timing-detail-name");
          append(detailName, el("span", "", detail.label || String(detail.id || "未命名细项")), el("span", "timing-detail-state", timingStageStatuses[detailStatus]));
          const detailDuration = el("span", "timing-detail-duration", detailSeconds === null ? "—" : formatElapsed(detailSeconds));
          detailDuration.title = detailSeconds === null ? unexecuted ? timingStageStatuses[detailStatus] : "此细项未记录有效耗时" : `${detailSeconds} 秒，${timingStageStatuses[detailStatus]}；已包含在本环节耗时中`;
          append(item, detailName, detailDuration); list.append(item);
        });
        row.append(group);
      }
      rows.append(row);
    }); panel.append(rows);
    const notes = el("div", "timings-notes");
    if (isRecovery(job)) notes.append(el("p", "", "本次仅统计本地恢复；来源任务的 AI 请求、用量和等待时间不计入本次。"));
    if (timings.scope === "server_request_to_terminal") notes.append(el("p", "", "从本地服务收到生成请求起计，含接收保存与排队；不含选择文件和网页轮询延迟。"));
    notes.append(el("p", "", "百分比为各环节占总耗时；进行中秒数随服务端轮询更新，未执行不记作 0 秒。下载为服务端最近持久化记录。"));
    if (timings.note) notes.append(el("p", "", timings.note));
    if (measuredSeconds(timings.total_seconds) === null) notes.append(el("p", "error-text", "总耗时数据无效，未据此推算。"));
    panel.append(notes);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options, headers: { ...(options.headers || {}) } });
    let data;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) data = await response.json();
    else data = { detail: (await response.text()).slice(0, 500) };
    if (!response.ok) {
      const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((item) => item.msg || jsonText(item)).join("；") : `请求未完成（${response.status}）`;
      const error = new Error(detail); error.status = response.status; throw error;
    }
    return data;
  }

  function activeStandard() { const library = state.promptLibrary; return library?.versions?.find((version) => version.id === library.active_version_id) || state.config?.prompt_library?.active || null; }
  function proposalRunning() { return Boolean(state.proposal && ["queued", "analyzing"].includes(state.proposal.status)); }
  function standardLocked() { return state.libraryBusy || Boolean(state.libraryMutation) || state.proposalBusy || Boolean(state.proposalPending) || proposalRunning(); }
  function canGeneralizeRound(job) { return state.mode === "job" && !state.file && job?.status === "completed" && canFeedback(job) && typeof job.options?.prompt === "string" && Boolean(job.options.prompt.trim()); }
  function roundIsHistorical(job) {
    const rounds = state.iterations.get(job.iteration?.root_job_id || job.id)?.jobs || [];
    return rounds.some((round) => Number(round.round || 1) > Number(job.iteration?.round || 1));
  }
  function renderSatisfiedRound() {
    const job = state.job; const eligible = canGeneralizeRound(job); const locked = standardLocked() || state.sourceBusy;
    show($("satisfied-standard-entry"), eligible);
    $("prepare-satisfied-standard").disabled = !eligible || locked;
    if (eligible) $("satisfied-entry-source").textContent = `${roundIsHistorical(job) ? "正在回看历史版本：" : "当前正在看的版本："}第 ${job.iteration?.round || 1} 轮 · ${job.id}。只选择这一轮，不会改选较新的轮次。`;
    const source = state.satisfiedRound; show($("satisfied-round-review"), Boolean(source));
    if (!source) return;
    $("satisfied-round-source").textContent = `已锁定${source.historical ? "历史版本 · " : ""}第 ${source.round} 轮 · ${source.job_id} · ${source.filename}。已应用反馈 ${source.feedback_version === null ? "无" : `v${source.feedback_version}`} / ${source.annotation_count} 个标记；不是当前编辑中的反馈草稿。`;
    $("satisfied-round-disclosure").textContent = `结合本轮画面和已应用反馈提炼，额外最多 1 次看图 AI，预计 ${source.image_count} 张原拼图；不会自动重试，不重剪视频。候选需另行确认后才用于新视频。`;
    const pending = state.proposalPending?.kind === "satisfied_round";
    $("create-satisfied-proposal").disabled = state.proposalBusy || state.libraryBusy || Boolean(state.libraryMutation) || state.sourceBusy || (Boolean(state.proposalPending) && !pending) || (!pending && (!state.promptLibrary || proposalRunning() || state.candidateConflict));
    $("create-satisfied-proposal").textContent = state.proposalBusy && pending ? "正在提交这一轮…" : pending ? "手动确认同一次整理 · 不重复建任务" : proposalRunning() ? "候选正在整理中…" : "结合这一轮画面整理候选 · 额外 1 次看图 AI";
    $("clear-satisfied-round").disabled = locked;
  }
  function prepareSatisfiedRound() {
    if (!canGeneralizeRound(state.job) || standardLocked() || state.sourceBusy) return;
    const job = state.job;
    state.satisfiedRound = { job_id: job.id, round: job.iteration?.round || 1, filename: job.filename || job.id, historical: roundIsHistorical(job), feedback_version: Number.isInteger(job.feedback?.version) ? job.feedback.version : null, annotation_count: job.feedback?.annotations?.length || 0, image_count: job.sampling?.sheets?.length || 0 };
    $("prompt-library-panel").open = true;
    state.proposalMessage = "已锁定你正在看的成功轮次，尚未调用 AI。请核对轮次与来源，再决定是否整理候选；未保存的修改不会混入。"; state.proposalError = false;
    renderPromptLibrary(); $("satisfied-round-review").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function createSatisfiedProposal() {
    if (state.proposalBusy || state.libraryBusy || state.libraryMutation || state.sourceBusy || (state.proposalPending && state.proposalPending.kind !== "satisfied_round")) return;
    if (!state.proposalPending) {
      if (!state.satisfiedRound || !state.promptLibrary || proposalRunning() || state.candidateConflict) return;
      if (!state.config?.configured) { state.proposalMessage = "请先配置模型连接。整理此轮将额外调用最多 1 次看图 AI；尚未提交，也不会生成视频。"; state.proposalError = true; renderPromptLibrary(); return; }
      state.proposalPending = { kind: "satisfied_round", path: "/api/prompt-proposals/satisfied-round", body: { expected_revision: state.promptLibrary.revision, request_id: crypto.randomUUID(), job_id: state.satisfiedRound.job_id } };
    }
    state.proposalBusy = true; state.proposalReadSequence++; renderPromptLibrary();
    try {
      const pending = state.proposalPending;
      const proposal = await api(pending.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.body) });
      state.proposalPending = null; state.proposal = proposal; state.candidateReviewedId = null;
      state.proposalMessage = "已提交所选满意轮次的候选整理。最多额外 1 次看图 AI，不重剪视频、不自动生效；完成后请核对全文、真实差异与来源。"; state.proposalError = false;
      renderProposalControls(); renderPromptProposal(); schedulePromptProposal(); $("proposal-review-area").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) state.proposalPending = null;
      if (error.status === 409) { state.candidateConflict = true; state.libraryConflict = true; }
      state.proposalError = true;
      state.proposalMessage = uncertain && state.proposalPending ? `提交结果尚未确定：${error.message}。不会自动重试；所选成功轮次、完整内容和请求 ID 已锁定。请手动确认同一次整理，即使切换视频也不改变来源。` : `满意轮次整理未创建：${error.message}。请手动刷新检查；原结果、反馈草稿、编辑稿与已有候选保留，没有自动重发。`;
    } finally { state.proposalBusy = false; renderPromptLibrary(); }
  }
  function resetStandardDraft(version = activeStandard()) {
    if (!version) return;
    state.standardDraft = { text: version.text, name: "", baseline: version.text, baseRevision: state.promptLibrary?.revision ?? state.config?.prompt_library?.revision, baseVersionId: version.id, proposalId: null, dirty: false };
    state.libraryConflict = false; $("confirm-standard-publish").checked = false;
  }
  function acceptLibrary(data, resetDraft = false) {
    if (!Number.isInteger(data?.revision) || !Array.isArray(data.versions) || !data.versions.some((version) => version.id === data.active_version_id && typeof version.text === "string")) throw new Error("通用标准记录格式不完整，编辑稿未被覆盖。");
    if (state.promptLibrary && data.revision < state.promptLibrary.revision) return false;
    const previousRevision = state.promptLibrary?.revision;
    state.promptLibrary = data;
    const active = activeStandard();
    if (state.config) { state.config.prompt_template = active.text; state.config.prompt_library = { revision: data.revision, active_version_id: active.id, active }; }
    if (!state.standardDraft || resetDraft) resetStandardDraft(active);
    else state.libraryConflict = state.standardDraft.baseRevision !== data.revision;
    if (previousRevision !== undefined && previousRevision !== data.revision) { $("confirm-standard-publish").checked = false; state.candidateReviewedId = null; }
    if (state.promptMode === "global" && !(state.job && feedbackDraft(state.job.id).pendingRevision)) { $("prompt-template").value = active.text; state.promptDirty = false; }
    renderPromptMode(); renderPromptLibrary(); return true;
  }
  async function loadPromptLibrary(options = {}) {
    if (state.libraryLoading) return;
    state.libraryLoading = true; renderPromptLibrary();
    try { const accepted = acceptLibrary(await api("/api/prompt-library")); if (accepted && options.explicit !== false) state.candidateConflict = false; state.libraryMessage = !accepted ? "较早读取的旧快照已忽略，保留当前较新标准与编辑稿。未调用 AI。" : state.libraryConflict ? "已读到服务器最新标准；本机编辑稿和候选保留。请核对后明确选择如何继续。" : "标准已刷新。未调用 AI，也没有自动发布任何候选；如文字整理仍有来源冲突，请显式检查来源版本。"; state.libraryError = false; }
    catch (error) { state.libraryMessage = `无法读取通用标准：${error.message}。本次任务模板和本机编辑稿保持不变。`; state.libraryError = true; }
    finally { state.libraryLoading = false; renderPromptLibrary(); }
  }
  function useActivePrompt() {
    if (state.revisionBusy || (state.job && feedbackDraft(state.job.id).pendingRevision)) return;
    const active = activeStandard(); const text = active?.text ?? state.config?.prompt_template;
    if (typeof text !== "string") { toast("请先读取生效标准。"); return; }
    $("prompt-template").value = text; state.promptDirty = false; state.promptMode = active ? "global" : "custom";
    renderPromptMode(); updateOptionsPreview();
  }
  function renderPromptMode() {
    const active = activeStandard(); const historical = state.mode === "job" && !state.file;
    let label = active && (state.promptMode === "global" || !$("prompt-template").value.trim()) ? `本次跟随生效标准 ${active.id} · 提交时由服务器冻结最新版本` : "本次自定义 · 不会发布到通用标准";
    if (historical) label += state.job.prompt_standard?.mode === "global" ? `。原任务实际使用 ${state.job.prompt_standard.version_id || "其保存的生效版"}；原记录不变。` : "。旧任务保留原指令；没有补造它的标准版本。";
    $("prompt-mode").textContent = label;
    $("use-active-prompt").disabled = !active || state.revisionBusy || Boolean(state.job && feedbackDraft(state.job.id).pendingRevision);
  }
  function renderPromptLibrary() {
    const library = state.promptLibrary; const active = activeStandard(); const draft = state.standardDraft; const locked = standardLocked();
    $("prompt-active-badge").textContent = active ? `${active.id} · 生效中` : state.libraryLoading ? "读取标准" : "尚未读取";
    $("prompt-library-status").textContent = active ? `${active.name || "通用标准"} · revision ${library?.revision ?? "—"}。新视频自动沿用；旧视频和本次自定义不会被改写。` : "仅保存在本机。候选不会自动生效；保存发布、查看和回退均不调用 AI。";
    $("refresh-prompt-library").disabled = state.libraryLoading;
    $("refresh-prompt-library").textContent = state.libraryLoading ? "正在检查…" : "刷新检查 · 0 次 AI";
    $("prompt-library-message").textContent = state.libraryMessage;
    $("prompt-library-message").className = `feedback-message${state.libraryError ? " error-text" : ""}`;
    if (draft) { if ($("standard-editor").value !== draft.text) $("standard-editor").value = draft.text; if ($("standard-name").value !== draft.name) $("standard-name").value = draft.name; }
    ["standard-editor", "standard-name", "confirm-standard-publish", "edit-active-standard"].forEach((id) => { $(id).disabled = locked || !draft; });
    $("edit-active-standard").textContent = draft?.dirty ? "用生效版替换编辑稿" : "载入生效版";
    $("active-standard-text").textContent = active?.text || "尚未读取生效标准。";
    const publishPending = state.libraryMutation?.kind === "publish"; const activatePending = state.libraryMutation?.kind === "activate";
    $("publish-standard").textContent = state.libraryBusy && publishPending ? "正在确认发布…" : publishPending ? "手动确认同一次发布 · 0 次 AI" : "确认发布新版本 · 0 次 AI ↗";
    $("publish-standard").disabled = state.libraryBusy || Boolean(state.proposalPending) || state.proposalBusy || proposalRunning() || (!publishPending && (Boolean(state.libraryMutation) || !draft?.dirty || !$("confirm-standard-publish").checked || state.libraryConflict || draft.baseRevision !== library?.revision));
    const conflict = $("prompt-library-conflict"); conflict.replaceChildren(); show(conflict, Boolean(state.libraryConflict));
    if (state.libraryConflict) {
      conflict.append(el("p", "", "标准基线已变化，或发布遇到版本冲突。编辑稿与 AI 候选均保留，未自动覆盖。请先刷新检查，展开「当前生效全文」核对。"));
      if (library && draft && draft.baseRevision !== library.revision) conflict.append(makeButton("已核对，以当前版本为基线（保留编辑稿）", "secondary-button", () => { if (standardLocked()) return; draft.baseRevision = library.revision; draft.baseVersionId = library.active_version_id; draft.baseline = active.text; draft.proposalId = null; draft.dirty = true; state.libraryConflict = false; $("confirm-standard-publish").checked = false; state.libraryMessage = "已明确保留编辑稿并更新基线；原候选仍可回看。请再次核对完整文本并勾选发布确认。"; renderPromptLibrary(); }));
    }
    const versions = $("standard-version-list"); versions.replaceChildren();
    (library?.versions || []).slice().reverse().forEach((version) => {
      const selected = state.activationTarget === version.id; const current = library.active_version_id === version.id;
      const button = makeButton(`${version.id} · ${version.name || "未命名标准"}${current ? " · 生效中" : ""}`, `standard-version${selected ? " selected" : ""}${current ? " active" : ""}`, () => { if (standardLocked()) return; state.activationTarget = version.id; renderPromptLibrary(); });
      button.dataset.standardVersionId = version.id; button.setAttribute("aria-pressed", String(selected)); button.disabled = locked; versions.append(button);
      if (version.summary) versions.append(el("p", "field-help", version.summary));
    });
    $("activate-standard-target").textContent = state.activationTarget ? `将切换到 ${state.activationTarget}；不删除历史，不改旧任务，不调用 AI。` : "先选历史版本，再明确确认切换；不会删除任何版本。";
    $("activate-standard").textContent = state.libraryBusy && activatePending ? "正在确认切换…" : activatePending ? "手动确认同一次切换 · 0 次 AI" : "确认切换所选版本 · 0 次 AI";
    $("activate-standard").disabled = state.libraryBusy || state.proposalBusy || Boolean(state.proposalPending) || proposalRunning() || (!activatePending && (Boolean(state.libraryMutation) || !state.activationTarget || state.activationTarget === library?.active_version_id || state.libraryConflict));
    const history = $("proposal-history"); history.replaceChildren();
    (library?.proposals || []).slice().reverse().forEach((proposal) => { const button = makeButton(`${proposal.id} · ${{ queued: "排队", analyzing: "整理中", completed: "候选已完成", failed: "失败", interrupted: "已中断" }[proposal.status] || proposal.status || "查看"}${proposal.summary ? ` · ${proposal.summary}` : ""}`, "text-button tiny", () => openPromptProposal(proposal.id)); button.disabled = locked; history.append(button); });
    if (!library?.proposals?.length) history.append(el("p", "field-help", "还没有候选整理记录。手动编辑和发布不需要先调用 AI。"));
    renderPromptSources(); renderProposalControls(); renderSatisfiedRound(); renderPromptProposal();
  }
  async function mutatePromptLibrary(kind) {
    if (state.libraryBusy || state.proposalBusy || state.proposalPending || proposalRunning()) return;
    if (!state.libraryMutation) {
      const library = state.promptLibrary; const draft = state.standardDraft; if (!library || (kind !== "candidate" && state.libraryConflict)) return;
      let path; let body;
      if (kind === "candidate") {
        const proposal = state.proposal;
        if (state.candidateConflict || proposal?.source_mode !== "satisfied_round" || proposal.status !== "completed" || state.candidateReviewedId !== proposal.id || proposal.base_revision !== library.revision || typeof proposal.candidate_prompt !== "string" || !proposal.candidate_prompt.trim() || proposal.candidate_prompt.length > 40000) return;
        path = "/api/prompt-library/versions"; body = { expected_revision: proposal.base_revision, request_id: crypto.randomUUID(), text: proposal.candidate_prompt, name: `满意第 ${proposal.satisfied_round?.round || 1} 轮 · 通用标准`, proposal_id: proposal.id };
      } else if (kind === "publish") {
        if (!draft?.dirty || !$("confirm-standard-publish").checked || draft.baseRevision !== library.revision) return;
        if (!draft.text.trim() || draft.text.length > 40000) { state.libraryMessage = "完整标准需要 1–40000 个字符；编辑稿未丢失。"; state.libraryError = true; renderPromptLibrary(); return; }
        path = "/api/prompt-library/versions"; body = { expected_revision: library.revision, request_id: crypto.randomUUID(), text: draft.text, name: draft.name.trim() };
        if (draft.proposalId) body.proposal_id = draft.proposalId;
      } else {
        if (!state.activationTarget || state.activationTarget === library.active_version_id) return;
        path = "/api/prompt-library/activate"; body = { expected_revision: library.revision, request_id: crypto.randomUUID(), version_id: state.activationTarget };
      }
      state.libraryMutation = { kind, path, body, preserveDraft: kind === "candidate" && Boolean(draft?.dirty) };
    }
    if (state.libraryMutation.kind !== kind) return;
    state.libraryBusy = true; state.libraryError = false; state.libraryMessage = "正在提交这次明确确认；不会调用 AI。"; renderPromptLibrary();
    const pending = state.libraryMutation;
    try {
      const library = await api(pending.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.body) });
      state.libraryMutation = null; state.activationTarget = null; state.candidateConflict = false;
      acceptLibrary(library, pending.kind === "publish" || (pending.kind === "candidate" ? !pending.preserveDraft : !state.standardDraft?.dirty));
      state.libraryMessage = pending.kind === "candidate" ? `满意轮次候选已明确发布并生效。后续新视频自动沿用；旧任务与本次自定义不变。${pending.preserveDraft ? "独立编辑稿已保留，未被候选覆盖；它仍保留原基线，不能直接覆盖新标准。" : ""}本次发布 0 次 AI。` : pending.kind === "publish" ? "新标准已发布并生效。后续新视频自动沿用；旧任务与本次自定义不变。0 次 AI。" : "已明确切换生效版本。历史版本、旧任务和本机编辑稿均保留。0 次 AI。";
      state.libraryError = false;
    } catch (error) {
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) state.libraryMutation = null;
      if (error.status === 409) { state.libraryConflict = true; if (pending.kind === "candidate") { state.candidateConflict = true; state.candidateReviewedId = null; } }
      state.libraryError = true; state.libraryMessage = uncertain ? `结果尚未确定：${error.message}。没有自动重试。编辑稿已锁定，请手动确认同一次提交；复用相同 ID 和完整内容，不会创建第二次相同变更。` : `未完成：${error.message}。编辑稿和候选保留；请手动刷新检查，不会自动覆盖或重试。`;
    } finally { state.libraryBusy = false; renderPromptLibrary(); renderPromptMode(); }
  }
  function renderPromptSources() {
    const locked = standardLocked() || state.sourceBusy; const list = $("prompt-source-list"); list.replaceChildren();
    state.promptSources.forEach((source, id) => { const row = el("div", "prompt-source"); row.append(el("span", "", `${source.filename || id} · 反馈 v${source.feedback_version}`)); const button = makeButton("移除", "text-button tiny", () => { if (!standardLocked()) { state.promptSources.delete(id); renderPromptLibrary(); } }); button.disabled = locked; row.append(button); list.append(row); });
    if (!state.promptSources.size) list.append(el("p", "field-help", "尚未选来源。可从当前视频开始；只采用明确保存的反馈，不推测你没标记的画面。"));
    const select = $("prompt-source-job"); const chosen = select.value; select.replaceChildren(); const empty = el("option", "", "其他已保存反馈的任务…"); empty.value = ""; select.append(empty);
    state.jobs.filter((job) => terminal.has(job.status) && !state.promptSources.has(job.id)).forEach((job) => { const option = el("option", "", `${job.filename || job.id} · ${statusNames[job.status] || job.status}`); option.value = job.id; select.append(option); }); select.value = chosen;
    select.disabled = locked; $("add-prompt-source").disabled = locked || state.promptSources.size >= 12;
    $("refresh-prompt-sources").disabled = locked || !state.promptSources.size;
    $("add-current-prompt-source").disabled = locked || state.mode !== "job" || !canFeedback(state.job) || state.promptSources.size >= 12;
  }
  async function addPromptSource(id) {
    if (!id || standardLocked() || state.sourceBusy) return false;
    if (state.promptSources.has(id)) return true;
    if (state.promptSources.size >= 12) { state.proposalMessage = "最多选择 12 段视频；请先移除一个来源。"; renderProposalControls(); return false; }
    state.sourceBusy = true; renderPromptLibrary();
    try {
      let job; let record;
      if (state.mode === "job" && state.job?.id === id) {
        job = state.job; const draft = feedbackDraft(id); if (!draft.ready) await ensureFeedback(job);
        if (!draft.ready) throw new Error("请先成功读取当前反馈");
        if (!draft.annotations.size && !draft.note.trim()) throw new Error("请先标记喜欢 / 不想要，或补充整体意见");
        record = { version: draft.version };
      } else {
        job = await api(`/api/jobs/${encodeURIComponent(id)}`);
        if (!canFeedback(job)) throw new Error("该任务还没有可复用的完整源记录");
        record = await api(`/api/jobs/${encodeURIComponent(id)}/feedback`);
        if (!Number.isInteger(record?.version) || !Array.isArray(record.annotations) || (!record.annotations.length && !record.note?.trim())) throw new Error("该任务尚无已保存反馈，请先打开并保存标记");
      }
      state.promptSources.set(id, { job_id: id, feedback_version: record.version, filename: job.filename || id });
      state.proposalMessage = "已加入来源。整理时会先保存此页面已有的脏反馈，再冻结保存版本；不会重新看图。"; state.proposalError = false; return true;
    } catch (error) { state.proposalMessage = `未加入来源：${error.message}。未调用 AI。`; state.proposalError = true; return false; }
    finally { state.sourceBusy = false; renderPromptLibrary(); }
  }
  async function refreshPromptSources() {
    if (standardLocked() || state.sourceBusy || !state.promptSources.size) return;
    state.sourceBusy = true; renderPromptLibrary();
    try {
      let conflicts = 0;
      for (const [id, source] of state.promptSources) {
        const remote = await api(`/api/jobs/${encodeURIComponent(id)}/feedback`);
        if (!Number.isInteger(remote?.version) || !Array.isArray(remote.annotations) || typeof remote.note !== "string") throw new Error("来源反馈格式不完整");
        const draft = state.drafts.get(id);
        if (draft?.ready && draft.version !== remote.version) {
          draft.conflict = true; draft.remote = remote; draft.message = "显式检查发现来源反馈有新版本；本机草稿未覆盖。请在此视频反馈区明确选择服务器版或自己的完整草稿。"; conflicts++; refreshFeedback(id, true);
        } else source.feedback_version = remote.version;
      }
      state.proposalMessage = conflicts ? `已检查来源；${conflicts} 段与本机反馈版本不同，请打开相应视频明确处理。通用标准编辑稿、候选和本地反馈都保留。` : "来源版本已明确刷新，未改动本机反馈或标准编辑稿。可以重新手动整理；没有调用 AI。"; state.proposalError = Boolean(conflicts);
    } catch (error) { state.proposalMessage = `来源检查未完成：${error.message}。本机草稿保留，未调用 AI。`; state.proposalError = true; }
    finally { state.sourceBusy = false; renderPromptLibrary(); }
  }
  function renderProposalControls() {
    const running = state.proposal && ["queued", "analyzing"].includes(state.proposal.status); const locked = standardLocked();
    const ownPending = state.proposalPending && state.proposalPending.kind !== "satisfied_round";
    $("proposal-note").disabled = locked;
    $("generate-prompt-proposal").disabled = state.proposalBusy || state.libraryBusy || Boolean(state.libraryMutation) || state.sourceBusy || (Boolean(state.proposalPending) && !ownPending) || (!ownPending && (!state.promptLibrary || !state.promptSources.size || running || state.libraryConflict));
    $("generate-prompt-proposal").textContent = state.proposalBusy && ownPending ? "正在提交文字整理…" : ownPending ? "手动确认同一次文字整理 · 不重复建任务" : running ? "候选正在整理中…" : "整理成通用 Prompt · 额外 1 次文字 AI";
    $("proposal-message").textContent = state.proposalMessage;
    $("proposal-message").className = `feedback-message${state.proposalError ? " error-text" : ""}`;
    show($("proposal-review-area"), Boolean(state.proposal || state.proposalMessage));
    const visual = state.proposalPending?.kind === "satisfied_round" || state.proposal?.source_mode === "satisfied_round";
    $("proposal-review-heading").textContent = `${visual ? "满意轮次 · 看图提炼候选" : "本次候选"} · 等你确认后才生效`;
  }
  async function createPromptProposal() {
    if (state.proposalBusy || state.libraryBusy || state.libraryMutation || state.sourceBusy || state.proposalPending?.kind === "satisfied_round") return;
    const running = state.proposal && ["queued", "analyzing"].includes(state.proposal.status);
    if (!state.proposalPending && (!state.promptLibrary || !state.promptSources.size || running || state.libraryConflict)) return;
    if (!state.proposalPending && !state.config?.configured) { state.proposalMessage = "请先配置模型连接。此入口只会发额外 1 次文字请求、0 图。"; state.proposalError = true; renderProposalControls(); return; }
    state.proposalBusy = true; state.proposalReadSequence++; renderPromptLibrary();
    try {
      if (!state.proposalPending) {
        for (const [id, source] of state.promptSources) {
          const draft = state.drafts.get(id);
          if (draft?.conflict) throw new Error(`来源 ${source.filename} 的反馈存在版本冲突，请先明确处理`);
          if (draft?.dirty && !await saveFeedback(id)) throw new Error(`来源 ${source.filename} 的反馈尚未成功保存`);
          if (draft?.ready) source.feedback_version = draft.version;
        }
        state.proposalPending = { kind: "feedback", body: { expected_revision: state.promptLibrary.revision, request_id: crypto.randomUUID(), sources: [...state.promptSources.values()].map(({ job_id, feedback_version }) => ({ job_id, feedback_version })), note: $("proposal-note").value } };
      }
      renderPromptLibrary();
      const proposal = await api("/api/prompt-proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.proposalPending.body) });
      state.proposalPending = null; state.proposal = proposal; state.candidateReviewedId = null; state.proposalMessage = "已创建文字建议任务。候选不会自动生效；请等待结果后编辑、明确确认发布。"; state.proposalError = false;
      renderPromptProposal(); schedulePromptProposal();
    } catch (error) {
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) state.proposalPending = null;
      if (error.status === 409) state.libraryConflict = true;
      state.proposalError = true; state.proposalMessage = uncertain && state.proposalPending ? `提交结果尚未确定：${error.message}。不会自动重试；来源版本、指令和请求 ID 已锁定，请手动确认同一次提交。` : `文字整理未创建：${error.message}。反馈、编辑稿和已有候选保留，没有自动再次调用 AI。`;
    } finally { state.proposalBusy = false; renderPromptLibrary(); }
  }
  function schedulePromptProposal() {
    clearTimeout(state.proposalTimer); state.proposalTimer = null;
    if (state.proposal && ["queued", "analyzing"].includes(state.proposal.status)) state.proposalTimer = setTimeout(() => openPromptProposal(state.proposal.id), 1500);
  }
  async function openPromptProposal(id) {
    if (!id) return;
    if ((standardLocked() || state.sourceBusy) && state.proposal?.id !== id) return;
    clearTimeout(state.proposalTimer); state.proposalTimer = null;
    const readSequence = ++state.proposalReadSequence;
    try { const record = await api(`/api/prompt-proposals/${encodeURIComponent(id)}`); if (readSequence !== state.proposalReadSequence || state.proposalPending || state.proposalBusy || state.libraryMutation) return; if (state.proposal?.id !== record.id) state.candidateReviewedId = null; state.proposal = record; state.proposalError = false; renderPromptProposal(); if (!["queued", "analyzing"].includes(state.proposal.status)) loadPromptLibrary({ explicit: false }); }
    catch (error) { state.proposalMessage = `建议进度暂不可读取：${error.message}。不会重发文字 AI 请求。`; state.proposalError = true; }
    finally { renderPromptLibrary(); schedulePromptProposal(); }
  }
  function adoptPromptCandidate() {
    const proposal = state.proposal; if (standardLocked() || proposal?.status !== "completed" || typeof proposal.candidate_prompt !== "string") return;
    if (proposal.source_mode === "satisfied_round" && state.standardDraft?.dirty) return;
    state.standardDraft = { text: proposal.candidate_prompt, name: "", baseline: proposal.base_prompt || "", baseRevision: proposal.base_revision, baseVersionId: proposal.base_version_id, proposalId: proposal.id, dirty: true };
    state.libraryConflict = proposal.base_revision !== state.promptLibrary?.revision; $("confirm-standard-publish").checked = false;
    state.libraryMessage = "候选已载入独立编辑稿，尚未生效。请核对完整文本；只有勾选确认并发布才用于新视频。"; state.libraryError = false; renderPromptLibrary(); $("standard-editor").focus();
  }
  function renderPromptProposal() {
    const record = state.proposal; const box = $("proposal-content"); box.replaceChildren(); if (!record) return;
    const satisfied = record.source_mode === "satisfied_round"; const source = record.satisfied_round || {};
    const published = state.promptLibrary?.versions?.find((version) => version.source_proposal_id === record.id);
    const ai = record.ai || {}; const facts = el("div", "debug-meta");
    [`${record.id} · ${{ queued: "等待整理", analyzing: satisfied ? "结合本轮画面整理中" : "纯文字 AI 整理中", completed: published ? `已发布为 ${published.id}` : "候选已完成 · 尚未发布", failed: "候选整理失败", interrupted: "已中断" }[record.status] || record.status}`,
      ...(satisfied ? [`看图请求 ${ai.visual_call_count ?? 0} · 图片 ${ai.image_count ?? 0}`, `文字请求 ${ai.text_call_count ?? 0} · 额外最多 1 次看图 AI`] : [`文字请求尝试 ${ai.text_call_count ?? ai.call_count ?? 0} / 1`, `图片请求 ${ai.visual_call_count ?? 0}`]),
      `基于 ${record.base_version_id || "—"} / revision ${record.base_revision ?? "—"}`].forEach((text) => facts.append(el("span", "", text))); box.append(facts);
    if (record.error) box.append(el("p", "error-text field-help", record.error));
    if (record.summary) box.append(el("p", "field-help", record.summary));
    if (satisfied) {
      box.append(el("p", "satisfied-source", `候选来源：第 ${source.round || 1} 轮 · ${source.job_id || "未记录"} · 本轮已应用反馈 ${source.has_applied_feedback === false || source.feedback_version === null || source.feedback_version === undefined ? "无" : `v${source.feedback_version}`} / ${source.annotation_count ?? 0} 个标记。不会改用家族最新轮或当前反馈草稿。`));
      box.append(codeSection("成功轮次的实际模板 · 提炼依据", record.tuning_base_prompt || "未记录", "这是该成功轮次保存的实际指令，独立于当前生效通用标准；真实差异仍以冻结的全局基线计算。"));
    }
    if (record.status === "completed" && typeof record.candidate_prompt === "string") {
      box.append(codeSection(published ? `候选全文 · 已发布为 ${published.id}` : "AI 候选全文 · 尚未生效", record.candidate_prompt, satisfied ? "结合这一轮原拼图、实际指令与已应用反馈提炼。不重剪视频，不训练模型；候选不会自动生效。" : "只根据已保存文字反馈提炼；不是重新理解视频，也不是训练模型。"));
      const adopt = makeButton(state.standardDraft?.dirty ? "用候选替换独立编辑稿（还不生效） ↗" : "载入候选到编辑稿（还不生效） ↗", "secondary-button", adoptPromptCandidate); adopt.dataset.adoptCandidate = "true"; adopt.disabled = standardLocked() || (satisfied && Boolean(state.standardDraft?.dirty)); box.append(adopt);
      if (satisfied && state.standardDraft?.dirty) box.append(el("p", "field-help", "独立编辑稿有未发布修改，未用候选替换它。可以在下方直接核对并确认此候选，原草稿会完整保留。"));
    }
    if (typeof record.diff === "string") box.append(codeSection("程序计算的真实全文差异", record.diff || "（全文没有变化）", satisfied ? "候选与创建时生效的通用标准对比；不是拿这一轮的自定义模板冒充全局差异。" : "差异对比候选与其冻结基线，不用模型自己宣称的改动替代。"));
    if (record.changes?.length) {
      const changes = el("div", "proposal-changes"); record.changes.forEach((change) => { const row = el("article", "proposal-change"); append(row, el("h4", "", change.reason || "修改理由"), el("pre", "", `原规则：${change.before || "（无）"}\n建议规则：${change.after || "（无）"}`)); const sources = el("div", "proposal-evidence"); (change.evidence || []).forEach((source) => { const button = makeButton(`${source.job_id}${source.frame_id ? ` / ${source.frame_id}` : ""} ↗`, "text-button tiny", async () => { await openJob(source.job_id); if (source.frame_id && state.job?.id === source.job_id) { const frame = findSample(state.job, source.frame_id); if (frame) openFrameDetail(frame, source.job_id); } }); sources.append(button); }); row.append(sources); changes.append(row); }); box.append(changes);
    }
    if (record.warnings?.length) { const warnings = el("div", "warnings"); record.warnings.forEach((warning) => warnings.append(el("p", "", warning))); box.append(warnings); }
    if (satisfied && record.status === "completed" && typeof record.candidate_prompt === "string") {
      const pending = state.libraryMutation?.kind === "candidate" && state.libraryMutation.body.proposal_id === record.id;
      const stale = record.base_revision !== state.promptLibrary?.revision;
      const locked = standardLocked();
      const confirm = el("label", "publish-confirm candidate-confirm");
      const checkbox = el("input"); checkbox.id = "confirm-prompt-candidate"; checkbox.type = "checkbox"; checkbox.checked = state.candidateReviewedId === record.id;
      checkbox.disabled = locked || stale || state.candidateConflict || Boolean(published);
      checkbox.addEventListener("change", () => { if (standardLocked() || record.id !== state.proposal?.id || record.base_revision !== state.promptLibrary?.revision || state.candidateConflict || published) return; state.candidateReviewedId = checkbox.checked ? record.id : null; renderPromptProposal(); });
      append(confirm, checkbox, el("span", "", `我已核对候选全文、真实差异和第 ${source.round || 1} 轮来源，确认用于后续新视频；不覆盖独立编辑稿。`)); box.append(confirm);
      const publish = makeButton(pending ? state.libraryBusy ? "正在确认设为通用…" : "手动确认同一次设为通用 · 0 次 AI" : "确认设为通用 · 0 次 AI", "secondary-button feedback-primary", () => mutatePromptLibrary("candidate")); publish.id = "publish-prompt-candidate";
      publish.disabled = state.libraryBusy || state.proposalBusy || Boolean(state.proposalPending) || proposalRunning() || (!pending && (Boolean(state.libraryMutation) || stale || state.candidateConflict || Boolean(published) || state.candidateReviewedId !== record.id)); box.append(publish);
      if (published) box.append(el("p", "field-help", `此候选已发布为 ${published.id}。当前生效版本以顶部标记为准；旧任务与独立草稿均未被改写。`));
      else if (stale || state.candidateConflict) box.append(el("p", "error-text field-help", "候选的通用标准基线已变化，或发布遇到冲突；不能直接覆盖。请先手动刷新检查，再决定重新整理，或明确编辑核对；不会自动换基线、重发 AI 或发布。"));
    }
    const audit = el("details", "proposal-audit"); audit.append(el("summary", "", satisfied ? "本次看图请求、成功轮次来源、原始返回与耗时" : "本次文字请求、来源、原始返回与耗时"));
    audit.append(codeSection("冻结来源与整体意见", jsonText({ source_mode: record.source_mode, satisfied_round: record.satisfied_round, sources: record.sources, note: record.note, base_revision: record.base_revision, base_version_id: record.base_version_id })));
    if (satisfied) audit.append(codeSection("冻结的全局差异基线", record.base_prompt || "未记录", "候选发布受这一基线的 revision 校验，不会静默改用新的全局版本。"));
    if (record.prompt) audit.append(codeSection(satisfied ? "实际发送 · 多图提炼 Prompt" : "实际发送 · 纯文字 Prompt", jsonText(record.prompt), satisfied ? "使用所选成功轮次原拼图；图片数和请求次数按服务端实际记录显示，不重剪视频。" : "此处没有图片附件；文字请求尝试不保证送达或已被模型理解。"));
    if (ai.request_manifest) audit.append(codeSection("请求清单", jsonText(ai.request_manifest)));
    if (ai.raw_response !== undefined) audit.append(codeSection(satisfied ? "看图 AI 原始返回" : "文字 AI 原始返回", jsonText(ai.raw_response), "失败也保留；不会自动再次调用。", true));
    if (ai.usage) audit.append(codeSection("服务端记录的用量", jsonText(ai.usage)));
    if (record.timings) audit.append(codeSection("候选整理耗时记录", jsonText(record.timings), `服务端总耗时：${formatElapsed(record.timings.total_seconds)}。没有用浏览器时间补算。`)); box.append(audit);
  }

  function canFeedback(job) { return Boolean(job && terminal.has(job.status) && job.source && job.sampling?.frames?.length && job.sampling?.sheets?.length); }
  function feedbackDraft(id) {
    if (!state.drafts.has(id)) state.drafts.set(id, { attempted: false, loading: false, ready: false, version: 0, annotations: new Map(), note: "", baseline: "", dirty: false, saving: false, message: "", error: false, conflict: null, remote: null, pendingRevision: null });
    return state.drafts.get(id);
  }
  function feedbackPayload(draft) { return { annotations: [...draft.annotations.values()].map((item) => ({ ...item })).sort((a, b) => a.frame_id.localeCompare(b.frame_id)), note: draft.note }; }
  function acceptFeedback(draft, data) {
    if (!data || !Number.isInteger(data.version) || !Array.isArray(data.annotations) || typeof data.note !== "string") throw new Error("反馈记录格式不完整，草稿没有被覆盖。");
    draft.version = data.version;
    draft.annotations = new Map(data.annotations.filter((item) => item && typeof item.frame_id === "string" && ["like", "dislike"].includes(item.label)).map((item) => [item.frame_id, { frame_id: item.frame_id, label: item.label, reason: typeof item.reason === "string" ? item.reason : "" }]));
    draft.note = data.note; draft.baseline = jsonText(feedbackPayload(draft)); draft.dirty = false; draft.ready = true; draft.conflict = null; draft.remote = null;
  }
  function draftLocked(id) { const draft = feedbackDraft(id); return !draft.ready || draft.saving || state.revisionBusy || Boolean(draft.pendingRevision) || state.mode !== "job" || state.job?.id !== id || !canFeedback(state.job); }
  function touchDraft(draft) { draft.dirty = jsonText(feedbackPayload(draft)) !== draft.baseline; draft.message = ""; draft.error = false; }
  function refreshFeedback(id, evidence = false) {
    if (state.mode !== "job" || state.job?.id !== id) return;
    renderFeedbackPanel(state.job);
    if (evidence) { clearSourceVideo(); renderEvidence(state.job); }
    if (state.inspectedFrame?.jobId === id && evidence) renderFrameDialogControls();
  }
  async function ensureFeedback(job) {
    if (!canFeedback(job)) return;
    const draft = feedbackDraft(job.id); if (draft.attempted) return;
    draft.attempted = true; draft.loading = true; refreshFeedback(job.id);
    try { acceptFeedback(draft, await api(`/api/jobs/${encodeURIComponent(job.id)}/feedback`)); }
    catch (error) { draft.message = `无法读取反馈：${error.message}。没有发起 AI 重选。`; draft.error = true; }
    finally { draft.loading = false; refreshFeedback(job.id, true); }
  }
  function fillJobOptions(job) {
    const pendingOptions = feedbackDraft(job.id).pendingRevision?.body.options;
    const values = pendingOptions || job.options;
    if (!values) return;
    [["target-duration", "target_duration"], ["target-slider", "target_duration"], ["min-duration", "min_duration"], ["max-duration", "max_duration"]].forEach(([id, key]) => { if (values[key] !== undefined) $(id).value = values[key]; });
    const interval = String(values.sample_interval ?? 1);
    if (![...$("sample-interval").options].some((option) => option.value === interval)) { const option = el("option", "", `每 ${interval} 秒一帧 · 原任务`); option.value = interval; $("sample-interval").append(option); }
    $("sample-interval").value = interval;
    if (typeof values.prompt === "string") { $("prompt-template").value = values.prompt; state.promptDirty = true; }
    // Opening an old job always freezes its actual text, never today's active pointer.
    state.promptMode = pendingOptions?.use_active_prompt ? "global" : "custom";
    renderPromptMode(); updateOptionsPreview();
  }
  function revisionOptions(job) { return { ...getOptions(), sample_interval: Number(job.options?.sample_interval ?? job.sampling?.interval ?? 1) }; }
  function familyBusy(job) {
    const root = job.iteration?.root_job_id || job.id;
    return Boolean(state.iterations.get(root)?.jobs?.some((item) => !terminal.has(item.id === job.id ? job.status : item.status)));
  }
  function renderFeedbackPanel(job) {
    const panel = $("feedback-panel"); show(panel, state.mode === "job");
    if (state.mode !== "job") return;
    const draft = feedbackDraft(job.id); const eligible = canFeedback(job); const locked = draftLocked(job.id);
    const values = draft.pendingRevision?.body.options || revisionOptions(job);
    const annotations = [...draft.annotations.values()]; const likes = annotations.filter((item) => item.label === "like").length; const dislikes = annotations.length - likes;
    $("feedback-counts").textContent = `喜欢 ${likes} · 不想要 ${dislikes} · 其余中性`;
    $("feedback-save-state").textContent = draft.saving ? "正在保存" : draft.loading ? "载入反馈" : !eligible ? "暂不可提交" : draft.pendingRevision ? "提交快照已锁定" : !draft.ready ? "未读取反馈" : draft.dirty ? "未保存草稿" : `已保存 · v${draft.version}`;
    if ($("feedback-note").value !== draft.note) $("feedback-note").value = draft.note;
    $("feedback-note").disabled = locked;
    $("feedback-target").textContent = `本轮目标 ${formatSeconds(values.target_duration)} 秒 · ${formatSeconds(values.min_duration)}–${formatSeconds(values.max_duration)} 秒。重选固定每 ${formatSeconds(values.sample_interval)} 秒一帧，复用此任务原片和拼图，不用重新上传。${state.file ? "已选择新视频；要重选当前任务，请重新打开它，恢复其实际 Prompt。" : ""}`;
    $("save-feedback").disabled = locked || !draft.dirty || Boolean(draft.conflict);
    const busy = state.revisionBusy || draft.saving || !eligible || !draft.ready;
    $("revise-feedback").disabled = busy || Boolean(state.file) || (!draft.pendingRevision && (familyBusy(job) || Boolean(draft.conflict) || (!annotations.length && !draft.note.trim())));
    $("feedback-to-prompt").disabled = busy || standardLocked() || (!annotations.length && !draft.note.trim());
    $("revise-feedback").textContent = state.revisionBusy ? "正在提交这一轮…" : draft.pendingRevision ? "手动重试同一次提交 ↗" : "应用反馈，生成下一版 ↗";
    let message = draft.message;
    if (!message && !eligible) message = terminal.has(job.status) ? "此任务尚无可复用的源视频与完整采样；请打开有原图的真实任务。" : "本轮仍在运行，结束前不能提交下一轮；已有草稿会保留。";
    if (!message && draft.pendingRevision) message = "上次提交结果尚未确定。草稿和参数已锁定；手动重试只确认这次提交，不会创建第二个相同任务（若前次未到达服务器，会首次创建）。";
    if (!message && familyBusy(job)) message = "同视频还有一轮正在运行，请先等它结束；本页草稿不会被轮询覆盖。";
    $("feedback-message").textContent = message || "保存反馈不调用 AI；只有点击重选才创建新版本。实际发送内容可在新版本的 Prompt 页核对。";
    $("feedback-message").className = `feedback-message${draft.error ? " error-text" : ""}`;
    $("feedback-draft-preview").textContent = jsonText({ expected_version: draft.version, ...feedbackPayload(draft) });
    const conflict = $("feedback-conflict"); conflict.replaceChildren(); show(conflict, Boolean(draft.conflict));
    if (draft.attempted && !draft.ready && !draft.loading) {
      show(conflict, true); conflict.append(el("p", "", "尚未载入服务器反馈。可以手动重新读取，不会调用 AI。"));
      conflict.append(makeButton("手动重新读取反馈 · 0 次 AI", "text-button", async () => { draft.attempted = false; await ensureFeedback(job); }));
    }
    if (draft.conflict) {
      conflict.append(el("p", "", "服务器反馈已有新版本。本机草稿保留，未自动合并或覆盖。"));
      conflict.append(makeButton(draft.checkingRemote ? "正在检查…" : "检查服务器最新版本 · 0 次 AI", "text-button", () => checkRemoteFeedback(job.id)));
      if (draft.remote) {
        conflict.append(el("pre", "code-box", jsonText(draft.remote)));
        conflict.append(makeButton("使用服务器版本，替换本机草稿", "secondary-button", () => { acceptFeedback(draft, draft.remote); draft.message = "已明确切换到服务器版本。"; refreshFeedback(job.id, true); }));
        conflict.append(makeButton("确认用我的完整草稿覆盖该版本", "secondary-button", async () => { draft.version = draft.remote.version; draft.conflict = null; draft.remote = null; draft.dirty = true; await saveFeedback(job.id); }));
      }
    }
    const frozen = Boolean(draft.pendingRevision) || state.revisionBusy;
    ["target-duration", "target-slider", "min-duration", "max-duration", "prompt-template"].forEach((id) => { $(id).disabled = frozen; });
    $("sample-interval").disabled = frozen || (eligible && !state.file);
    renderPromptMode(); updateGenerateButton();
  }
  function setFrameVote(jobId, frameId, label, reason) {
    if (draftLocked(jobId)) return;
    const draft = feedbackDraft(jobId);
    if (label === null) draft.annotations.delete(frameId);
    else draft.annotations.set(frameId, { frame_id: frameId, label, reason: reason ?? draft.annotations.get(frameId)?.reason ?? "" });
    touchDraft(draft); refreshFeedback(jobId);
  }
  function voteControls(frame, jobId) {
    const frameId = frame.frame_id || frame.id; const draft = feedbackDraft(jobId); const controls = el("div", "frame-feedback"); controls.dataset.frameId = frameId;
    const buttons = el("div", "frame-vote-buttons"); const reason = el("textarea", "frame-feedback-reason"); reason.rows = 2; reason.maxLength = 500; reason.setAttribute("aria-label", `${frameId} 的可选反馈原因`); reason.placeholder = "原因（可选）：哪里萌 / 哪里不想留？";
    const update = () => {
      const vote = draft.annotations.get(frameId); const locked = draftLocked(jobId);
      controls.dataset.label = vote?.label || "neutral";
      buttons.children[0].setAttribute("aria-pressed", String(vote?.label === "like")); buttons.children[1].setAttribute("aria-pressed", String(vote?.label === "dislike"));
      [...buttons.children].forEach((button) => { button.disabled = locked; });
      reason.disabled = locked || !vote; if (reason.value !== (vote?.reason || "")) reason.value = vote?.reason || "";
    };
    [["like", "喜欢"], ["dislike", "不想要"], [null, "清除"]].forEach(([label, text]) => { const button = makeButton(text, "", () => { setFrameVote(jobId, frameId, label); update(); }); buttons.append(button); });
    reason.addEventListener("input", () => { const vote = draft.annotations.get(frameId); if (!vote || draftLocked(jobId)) return; setFrameVote(jobId, frameId, vote.label, reason.value); });
    append(controls, buttons, reason); update(); return controls;
  }
  async function saveFeedback(id) {
    const draft = feedbackDraft(id); if (!draft.ready || draft.saving || draft.pendingRevision) return false;
    if (!draft.dirty) return true;
    draft.saving = true; draft.message = ""; refreshFeedback(id, true);
    try {
      const saved = await api(`/api/jobs/${encodeURIComponent(id)}/feedback`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_version: draft.version, ...feedbackPayload(draft) }) });
      acceptFeedback(draft, saved); draft.message = "反馈已保存，仅此视频；没有调用 AI。"; draft.error = false; return true;
    } catch (error) { draft.message = `保存失败：${error.message}。本机草稿保留，没有调用 AI。`; draft.error = true; if (error.status === 409) draft.conflict = true; return false; }
    finally { draft.saving = false; refreshFeedback(id, true); }
  }
  async function checkRemoteFeedback(id) {
    const draft = feedbackDraft(id); if (draft.checkingRemote) return;
    draft.checkingRemote = true; refreshFeedback(id);
    try { const remote = await api(`/api/jobs/${encodeURIComponent(id)}/feedback`); if (!Number.isInteger(remote?.version) || !Array.isArray(remote.annotations) || typeof remote.note !== "string") throw new Error("服务器反馈格式无效"); draft.remote = remote; draft.message = "已展示服务器版本，本机草稿仍未改动。请明确选择如何处理。"; }
    catch (error) { draft.message = `检查失败：${error.message}。本机草稿仍保留。`; draft.error = true; }
    finally { draft.checkingRemote = false; refreshFeedback(id); }
  }
  async function reviseFeedback() {
    const job = state.job; if (state.mode !== "job" || !canFeedback(job) || state.revisionBusy || state.file) return;
    const draft = feedbackDraft(job.id); if (!draft.ready || draft.saving || draft.conflict) return;
    if (!draft.pendingRevision && (familyBusy(job) || (!draft.annotations.size && !draft.note.trim()))) return;
    if (!draft.pendingRevision && !state.config?.configured) { $("model-settings").open = true; draft.message = "请先配置可用的模型中转连接。重选将使用 gpt-6.1-sol。"; draft.error = true; refreshFeedback(job.id); return; }
    const options = draft.pendingRevision?.body.options || revisionOptions(job); const invalid = validateOptions(options);
    if (invalid) { draft.message = invalid; draft.error = true; refreshFeedback(job.id); return; }
    state.revisionBusy = true; refreshFeedback(job.id, true);
    try {
      if (!draft.pendingRevision) {
        if (!await saveFeedback(job.id)) return;
        if (typeof crypto?.randomUUID !== "function") throw new Error("当前浏览器不支持安全请求 ID，请使用新版浏览器。");
        draft.pendingRevision = { body: { expected_version: draft.version, request_id: crypto.randomUUID(), options: { ...options } } };
      }
      refreshFeedback(job.id, true);
      const child = await api(`/api/jobs/${encodeURIComponent(job.id)}/revise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft.pendingRevision.body) });
      draft.pendingRevision = null; draft.message = "已创建新版本；原版本和已保存反馈不变。"; draft.error = false;
      state.tab = "highlight"; renderJob(child); startPolling(); loadJobs(); loadIterations(child, true);
    } catch (error) {
      const uncertain = !error.status || error.status >= 500;
      if (!uncertain) draft.pendingRevision = null;
      if (error.status === 409) draft.conflict = true;
      draft.message = uncertain && draft.pendingRevision ? `提交结果尚未确定：${error.message}。不会自动重试。请手动重试同一次提交；会复用相同 ID 和快照。` : `重选未完成：${error.message}。反馈仍保留，没有自动再次调用 AI。`;
      draft.error = true;
    } finally { state.revisionBusy = false; refreshFeedback(job.id, true); if (state.mode === "job" && state.job?.id !== job.id) renderFeedbackPanel(state.job); updateGenerateButton(); }
  }
  function findSample(job, id) { return getEvidence(job).allFrames.find((frame) => (frame.frame_id || frame.id) === id); }
  async function loadIterations(job, force = false) {
    const rootId = job.iteration?.root_job_id || job.id;
    const cached = state.iterations.get(rootId);
    if (cached?.loading || (!force && cached?.loaded)) return;
    const record = cached || { jobs: [] }; record.loading = true; state.iterations.set(rootId, record); renderIterations(job);
    try { const data = await api(`/api/jobs/${encodeURIComponent(job.id)}/iterations`); record.jobs = Array.isArray(data.jobs) ? data.jobs : []; record.loaded = true; record.error = ""; }
    catch (error) { record.error = error.message; record.loaded = true; }
    finally { record.loading = false; if (state.mode === "job" && (state.job?.iteration?.root_job_id || state.job?.id) === rootId) { renderIterations(state.job); renderFeedbackPanel(state.job); } }
  }
  function renderIterations(job) {
    if (state.mode !== "job" || state.job?.id !== job.id) return;
    const panel = $("iterations-panel"); panel.replaceChildren(); show(panel, true);
    const rootId = job.iteration?.root_job_id || job.id; const record = state.iterations.get(rootId);
    renderSatisfiedRound();
    const heading = el("div", "iteration-heading"); append(heading, el("strong", "", "同视频版本"), el("span", "", "每轮独立保留 · 可切换回看"), makeButton("刷新版本", "text-button tiny", () => loadIterations(job, true))); panel.append(heading);
    const versions = record?.jobs?.length ? record.jobs : [{ id: job.id, round: job.iteration?.round || 1, status: job.status }];
    const nav = el("div", "iteration-versions"); nav.setAttribute("aria-label", "切换同视频版本");
    versions.forEach((version) => { const current = version.id === job.id; const button = makeButton(`V${version.round || 1} · ${statusNames[current ? job.status : version.status] || version.status}`, `iteration-version${current ? " current" : ""}`, () => openJob(version.id)); button.setAttribute("aria-current", String(current)); button.title = `任务 ${version.id}${version.parent_job_id ? `，源于 ${version.parent_job_id}` : "，首次生成"}`; nav.append(button); }); panel.append(nav);
    if (record?.error) panel.append(el("p", "field-help error-text", `版本列表暂不可用：${record.error}。本轮内容仍可查看。`));
    const comparison = job.comparison;
    if (comparison) {
      const summary = el("div", "comparison-summary");
      [["added_frame_ids", "新增"], ["removed_frame_ids", "移除"], ["kept_frame_ids", "保留"], ["liked_omitted_ids", "喜欢但仍漏选"], ["disliked_selected_ids", "不想要却仍被选"]].forEach(([key, label]) => {
        const ids = Array.isArray(comparison[key]) ? comparison[key] : []; const item = el("details", `comparison-detail ${key.includes("omitted") || key.includes("disliked_selected") ? "needs-attention" : ""}`); item.append(el("summary", "", `${label} ${ids.length}`));
        if (!ids.length) item.append(el("p", "", "本项没有帧。"));
        ids.forEach((id) => { const frame = findSample(job, id); item.append(makeButton(`${id}${frame ? ` · ${timecode(frame.time)}` : ""}`, "text-button tiny", () => { if (frame) openFrameDetail(frame, job.id); else toast(`此帧 ${id} 未在采样记录中找到。`); })); }); summary.append(item);
      }); panel.append(summary); panel.append(el("p", "field-help", "这是相对上一版的可爱证据帧变化，不是准确率，也不代表整段视频被精确新增或移除。喜欢可能因时长漏选；不想要仍被选时本轮会失败，不会偷偷改结果或再试一次。"));
    } else panel.append(el("p", "field-help", "本轮没有可比较的上一版。先标记喜欢与不想要，再手动生成下一版。"));
  }
  function openFrameDetail(frame, jobId) {
    if (state.mode !== "job" || state.job?.id !== jobId) return;
    state.inspectedFrame = { frame, jobId };
    const id = frame.frame_id || frame.id; $("frame-dialog-title").textContent = `${id} · 原片 ${timecode(frame.time)}`;
    const src = safeUrl(frame.url); if (src) $("frame-dialog-image").src = src; else $("frame-dialog-image").removeAttribute("src"); show($("frame-dialog-image"), Boolean(src));
    $("frame-dialog-image").alt = `${id}，原片 ${timecode(frame.time)}`;
    $("frame-dialog-reason").textContent = frame.reason || "本轮没有为这帧附上选择理由。你可以把漏选的好画面标为喜欢。";
    renderFrameDialogControls(); if (!$("frame-dialog").open) $("frame-dialog").showModal();
  }
  function renderFrameDialogControls() {
    const context = state.inspectedFrame; const target = $("frame-dialog-controls"); target.replaceChildren();
    if (context) target.append(voteControls(context.frame, context.jobId));
  }
  function handleSheetFrameClick(event) {
    const context = state.dialogSheet; if (!context || state.mode !== "job" || state.job?.id !== context.jobId) return;
    const image = $("dialog-image"); const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const width = context.sheet.width || image.naturalWidth; const height = context.sheet.height || image.naturalHeight;
    const x = (event.clientX - rect.left) / rect.width * width; const y = (event.clientY - rect.top) / rect.height * height;
    const frame = context.frames.find((item) => Array.isArray(item.box) && x >= item.box[0] && x < item.box[0] + item.box[2] && y >= item.box[1] && y < item.box[1] + item.box[3]);
    if (frame) openFrameDetail(frame, context.jobId); else toast("这里是拼图空白或标题区，请点击具体画面；没有修改任何评价。");
  }
  function getOptions() {
    const prompt = $("prompt-template").value; const useActive = state.promptMode === "global" || (!prompt.trim() && Boolean(activeStandard()));
    return { target_duration: Number($("target-duration").value), min_duration: Number($("min-duration").value), max_duration: Number($("max-duration").value), sample_interval: Number($("sample-interval").value), prompt, ...(useActive ? { use_active_prompt: true } : {}) };
  }
  function updateOptionsPreview() {
    const values = getOptions();
    $("options-preview").textContent = `精选目标：${formatSeconds(values.target_duration)} 秒\n允许范围：${formatSeconds(values.min_duration)}–${formatSeconds(values.max_duration)} 秒\n抽样间隔：${formatSeconds(values.sample_interval)} 秒 / 帧\n每张拼图：最多 60 帧\n视觉调用：1 次，所有拼图同一请求\n输出：原速原声精选 + 独立表情包`;
    if (state.mode === "job" && state.job) renderFeedbackPanel(state.job);
  }
  function validateOptions(options) {
    const durations = [options.min_duration, options.target_duration, options.max_duration];
    if (!durations.every((n) => Number.isFinite(n) && n >= 1 && n <= 120)) return "最短、目标、最长时长需要在 1–120 秒之间。";
    if (!(options.min_duration <= options.target_duration && options.target_duration <= options.max_duration)) return "请保持：最短时长 ≤ 精选目标 ≤ 最长时长。";
    if (!Number.isFinite(options.sample_interval) || options.sample_interval < .25 || options.sample_interval > 3) return "抽样间隔需要在 0.25–3 秒之间。";
    if (!options.prompt.trim() && !options.use_active_prompt) return "请先填写识别 Prompt。";
    if (options.prompt.length > 40000) return "本次 Prompt 最多 40000 个字符。";
    return null;
  }
  function isRunning() { return state.job && !terminal.has(state.job.status); }
  function updateGenerateButton() {
    const pending = state.mode === "job" && state.job && feedbackDraft(state.job.id).pendingRevision;
    const busy = state.submitting || isRunning() || state.revisionBusy || Boolean(pending);
    $("generate-button").disabled = busy;
    $("generate-button").firstElementChild.textContent = state.submitting ? "正在上传视频…" : state.revisionBusy ? "正在提交反馈重选…" : pending ? "上次提交结果待确认" : isRunning() ? "本次正在生成" : !state.config?.configured ? "配置模型，再开始生成" : "生成吃播精选";
  }

  function setConfigMessage(message = "", failed = false) {
    const box = $("config-message"); box.className = "field-help"; box.replaceChildren();
    const provider = state.config?.provider || {};
    const lines = [];
    if (message) lines.push([message, failed ? "error-text" : "good-text"]);
    if (provider.configuration_source === "codex") lines.push([`正在复用当前 GPT 中转配置${provider.model ? ` · ${provider.model}` : ""}。`, ""]);
    const warning = provider.transport_warning || state.config?.transport_warning;
    if (warning) lines.push([`传输提醒：${warning}`, "error-text"]);
    lines.forEach(([text, className], index) => { if (index) box.append(el("br")); box.append(el("span", className, text)); });
  }

  function applyConfig(config, overwrite = true) {
    state.config = config;
    $("config-badge").textContent = config.configured ? "已配置" : "待配置";
    $("config-badge").className = `summary-tag ${config.configured ? "good" : "needs-config"}`;
    $("key-status").textContent = config.provider?.key_configured ? "· 已设置，留空可保留" : "· 尚未设置";
    $("base-url").value = config.provider?.base_url || "";
    $("model-name").value = config.provider?.model || "";
    $("api-style").value = config.provider?.api_style || "chat_completions";
    if (config.prompt_library?.active) {
      if (!state.promptDirty && state.mode !== "job") state.promptMode = "global";
      if (!state.promptLibrary || config.prompt_library.revision >= state.promptLibrary.revision) {
        const active = config.prompt_library.active; const known = state.promptLibrary?.versions || [];
        const versions = known.some((item) => item.id === active.id) ? known.map((item) => item.id === active.id ? active : item) : [...known, active];
        acceptLibrary({ ...config.prompt_library, versions, proposals: state.promptLibrary?.proposals || [] });
      }
    }
    if (!state.promptDirty && typeof config.prompt_template === "string") $("prompt-template").value = config.prompt_template;
    if (overwrite && config.defaults) {
      $("target-duration").value = config.defaults.target_duration ?? 40;
      $("target-slider").value = config.defaults.target_duration ?? 40;
      $("min-duration").value = config.defaults.min_duration ?? 30;
      $("max-duration").value = config.defaults.max_duration ?? 50;
      const interval = String(config.defaults.sample_interval ?? 1);
      if ([...$("sample-interval").options].some((option) => option.value === interval)) $("sample-interval").value = interval;
    }
    if (config.limits?.max_upload_mb) $("file-limit").textContent = `最大 ${config.limits.max_upload_mb} MB`;
    setConfigMessage(); renderPromptMode(); updateOptionsPreview(); updateGenerateButton();
  }
  async function loadConfig() {
    try { applyConfig(await api("/api/config")); }
    catch (error) { $("config-badge").textContent = "未连接"; $("config-badge").className = "summary-tag needs-config"; notice(`本地服务未连接：${error.message}。请确认工作台服务仍在运行。`); }
  }
  async function saveConfig() {
    const button = $("save-config"); button.disabled = true; button.textContent = "正在保存…";
    const data = { base_url: $("base-url").value.trim(), model: $("model-name").value.trim(), api_style: $("api-style").value };
    const key = $("api-key").value.trim();
    if (key) data.api_key = key;
    $("api-key").value = "";
    try {
      if (!data.base_url || !data.model) throw new Error("请填写 API 地址和模型名称。");
      const config = await api("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      applyConfig(config, false);
      setConfigMessage(config.configured ? "连接配置已保存。生成时会发起真实请求，不会预先消耗一次看图。" : "配置已保存，但还缺少有效密钥或模型信息。", !config.configured);
      toast(config.configured ? "模型配置已保存" : "还需要补齐模型配置");
    } catch (error) { setConfigMessage(error.message, true); }
    finally { delete data.api_key; button.disabled = false; button.textContent = "保存连接"; }
  }

  function selectFile(file) {
    if (!file) return;
    if (state.revisionBusy || (state.job && feedbackDraft(state.job.id).pendingRevision)) { toast("当前重选提交尚未确认，请先确认同一次提交，再选择新视频。"); return; }
    const maxMB = state.config?.limits?.max_upload_mb ?? 512;
    if (file.size > maxMB * 1024 * 1024) { formError(`视频超过 ${maxMB} MB，请先压缩后再上传。`); return; }
    state.file = file;
    if (activeStandard()) useActivePrompt();
    $("file-label").textContent = file.name;
    $("file-description").textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 点击可重新选择`;
    $("drop-zone").classList.add("has-file");
    formError(null); renderPromptMode(); renderSatisfiedRound(); if (state.mode === "job") renderFeedbackPanel(state.job);
  }
  async function submitJob(event) {
    event.preventDefault();
    if (state.submitting || isRunning() || state.revisionBusy || (state.mode === "job" && state.job && feedbackDraft(state.job.id).pendingRevision)) return;
    if (!state.config?.configured) { $("model-settings").open = true; $("base-url").focus(); formError("先设置支持多张图片输入的模型连接，再生成视频。"); return; }
    if (!state.file) { formError("请先选择一段小猫吃播视频。"); $("video-file").focus(); return; }
    const options = getOptions(); const invalid = validateOptions(options);
    if (invalid) { formError(invalid); return; }
    formError(null); notice(null); resetTimingsPanel(); state.submitting = true; updateGenerateButton();
    const form = new FormData(); form.append("file", state.file); form.append("options", JSON.stringify(options));
    try {
      const job = await api("/api/jobs", { method: "POST", body: form });
      state.file = null; $("video-file").value = ""; $("file-description").textContent = "当前任务原片已保留；反馈重选不需重传，点击可选择新视频。";
      state.mode = "job"; state.legacy = null; state.tab = "highlight";
      renderJob(job); startPolling(); loadJobs();
      if (window.innerWidth < 761) $("workspace").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { formError(error.message); }
    finally { state.submitting = false; updateGenerateButton(); }
  }

  function setTab(tab, focus = false) {
    state.tab = tab;
    document.querySelectorAll("[data-tab]").forEach((button) => { const selected = button.dataset.tab === tab; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; if (focus && selected) button.focus(); });
    ["highlight", "memes", "evidence", "request"].forEach((name) => show($(`panel-${name}`), name === tab));
  }
  function placeholder(title, body) { const node = el("div", "placeholder-panel"); append(node, el("strong", "", title), el("p", "", body)); return node; }
  function clearSourceVideo() { state.sourceVideo = null; }

  function renderJob(job, restoreOptions = false) {
    const recovered = isRecovery(job);
    const previousStatus = state.job?.status;
    const newJob = state.mode !== "job" || state.job?.id !== job.id;
    if (newJob) { state.sectionSignatures = {}; state.evidenceMode = "selected"; state.dialogSheet = null; state.inspectedFrame = null; if ($("frame-dialog").open) $("frame-dialog").close(); if ($("image-dialog").open) $("image-dialog").close(); }
    state.job = job; state.mode = "job";
    if (newJob || restoreOptions) fillJobOptions(job);
    show($("empty-state"), false); show($("results"), true); show($("job-status"), true);
    $("workspace-title").textContent = job.filename || "这顿饭，正在整理。";
    $("workspace-description").textContent = recovered ? recoveryMessage(job) : "本次真实运行 · 输入拼图、AI 选择和最终剪辑都保留在这里。";
    const status = recovered && job.status === "analyzing" ? "核对已保存的 AI 结果" : statusNames[job.status] || job.status || "处理中";
    $("workspace-badge").textContent = status;
    $("workspace-badge").className = `workspace-badge ${job.status === "completed" ? "good" : job.status === "failed" ? "failed" : ""}`;
    $("job-status").className = `job-status ${!terminal.has(job.status) ? "running" : ""} ${job.status === "failed" ? "failed" : ""}`;
    $("job-stage").textContent = job.stage || status;
    const progress = Number.isFinite(Number(job.progress)) ? Math.max(0, Math.min(100, Number(job.progress))) : 0;
    $("job-percent").textContent = `${Math.round(progress)}%`;
    $("progress-bar").setAttribute("aria-valuenow", String(progress)); $("progress-bar").firstElementChild.style.width = `${progress}%`;
    $("job-message").textContent = job.error || job.message || "等待服务端更新。";
    show($("cancel-job"), !terminal.has(job.status));
    if (job.status === "failed") notice(`这次没有生成成功：${job.error || job.message || "未知错误"}\n${recovered ? `${recoveryMessage(job)}\n复用的历史拼图、Prompt 和模型返回仍可在下方查看。` : "已产生的拼图、发送 Prompt 和模型返回仍可在下方查看。不会自动再次调用 AI。"}`);
    else if (job.status === "cancelled") notice(recovered ? `本次本地恢复已取消。${recoveryMessage(job)}已保存的历史证据仍可查看。` : "本次任务已取消。已产生的调试材料仍保留；AI 请求若已发出，不会因此撤回。");
    else notice(recovered ? recoveryMessage(job) : null, recovered && job.status === "completed");
    const result = job.result || {};
    $("highlight-count").textContent = result.clips?.length ? String(result.clips.length) : "";
    $("meme-count").textContent = result.memes?.length ? String(result.memes.length) : "";
    $("sheet-count").textContent = job.sampling?.sheet_count ? String(job.sampling.sheet_count) : "";
    const sections = [
      ["timings", [job.timings, job.status, job.ai?.elapsed_seconds, job.id, recovered], () => renderTimings(job)],
      ["highlight", [job.result, job.status, job.options, job.source, job.ai?.parsed?.summary, job.ai?.call_count, job.recovery, recoverySource(job)], () => renderHighlight(job)],
      ["memes", [job.result?.memes, job.status, recovered], () => renderMemes(job)],
      ["evidence", [job.sampling, job.result?.selected_frames, job.source, job.ai?.call_count, job.status, job.ai?.parsed?.selected_frames, state.circled, state.evidenceMode, job.comparison, job.recovery, recoverySource(job)], () => { clearSourceVideo(); renderEvidence(job); }],
      ["request", [job.prompt, job.ai, job.options, job.result?.validation, job.timings, job.status, job.feedback, job.comparison, job.prompt_standard, job.recovery], () => renderRequest(job)]
    ];
    sections.forEach(([name, data, render]) => { const signature = jsonText(data); if (state.sectionSignatures[name] !== signature) { render(); state.sectionSignatures[name] = signature; } });
    setTab(state.tab); renderFeedbackPanel(job); renderIterations(job); updateGenerateButton(); ensureFeedback(job); loadIterations(job, newJob || (terminal.has(job.status) && previousStatus !== job.status));
    if (terminal.has(job.status) && previousStatus !== job.status) loadJobs();
  }

  function videoPlayer(url, className = "", controls = true) {
    const src = safeUrl(url); if (!src) return null;
    const video = el("video", className); video.src = src; video.controls = controls; video.preload = "metadata"; video.playsInline = true;
    video.addEventListener("error", () => { video.setAttribute("aria-label", "视频暂时无法加载，请尝试下载后播放"); });
    return video;
  }
  function renderHighlight(job) {
    const box = $("highlight-content"); box.replaceChildren();
    const result = job.result || {}; const recovered = isRecovery(job);
    if (!result.video_url) {
      const failed = job.status === "failed";
      box.append(placeholder(failed ? "这次还没有成片" : "让小小的表情，慢慢被找到。", failed ? "可以先去「AI 看到了什么」和「Prompt / 返回」检查此次运行。" : "精选导出完成后，原速原声的成片会出现在这里。进度以服务端实际步骤为准。"));
      if (result.clips?.length) box.append(makeTimeline(result.clips, job.source?.duration, null, recovered ? "原任务保存的剪辑区间" : "AI 返回的剪辑区间"));
      return;
    }
    const stage = el("div", "highlight-stage"); const screen = el("div", "video-screen"); const video = videoPlayer(result.video_url); if (video) screen.append(video);
    const meta = el("div", "highlight-meta"); append(meta, el("p", "eyebrow", "THE SELECTED LITTLE MOMENTS"), el("h3", "", "今天的可爱，\n剪好了。"));
    const summary = job.ai?.parsed?.summary || `${result.clips?.length || 0} 个片段，自然留白，不用重复画面凑时长。`;
    meta.append(el("p", "highlight-summary", summary));
    if (recovered) meta.append(el("p", "field-help good-text", recoveryMessage(job)));
    const compare = el("dl", "duration-comparison");
    const wanted = el("div"); append(wanted, el("dt", "", "你想要的")); const dd1 = el("dd", "", formatSeconds(job.options?.target_duration)); dd1.append(el("small", "", "秒")); wanted.append(dd1);
    const got = el("div"); got.append(el("dt", "", "实际精选")); const dd2 = el("dd", "", formatSeconds(result.video_duration, 2)); dd2.append(el("small", "", "秒")); got.append(dd2);
    append(compare, wanted, el("span", "separator"), got); meta.append(compare);
    const facts = el("div", "fact-list"); ["原速不加速", "保留原声", "无 BGM / 旁白", recovered ? "本次 0 次 AI 视觉调用" : `${job.ai?.call_count ?? "—"} 次 AI 视觉调用`].forEach((text) => facts.append(el("span", "", text))); meta.append(facts);
    append(meta, link("下载精选 MP4 ↗", result.video_url, "secondary-button", true)); append(stage, screen, meta); box.append(stage);
    box.append(makeTimeline(result.clips || [], job.source?.duration, video));
    if (result.warnings?.length) { const warnings = el("div", "warnings"); result.warnings.forEach((warning) => warnings.append(el("p", "", warning))); box.append(warnings); }
    if (result.adjustments?.length) { const details = el("details", "adjustments-box"); append(details, el("summary", "", `程序对时间轴做了哪些调整（${result.adjustments.length}）`), el("pre", "", jsonText(result.adjustments))); box.append(details); }
  }

  function seekVideo(video, value) {
    if (!video || !Number.isFinite(Number(value))) return;
    const seek = () => { video.currentTime = Math.max(0, Number(value)); video.play().catch(() => {}); };
    if (video.readyState >= 1) seek(); else video.addEventListener("loadedmetadata", seek, { once: true });
  }
  function makeTimeline(clips, sourceDuration, montageVideo, heading = "精选时间轴", independent = false) {
    const container = el("section", "timeline-section");
    const title = el("div", "section-title-row"); const description = el("div"); append(description, el("h3", "", heading), el("p", "", independent ? "每个表情包单独导出；下方是源视频区间，不是把它们串成一条新片。点击时间可核对原画面。" : "上方为成片顺序；下方保留原视频时间。点击时间可定位回看。")); title.append(description); container.append(title);
    const total = clips.reduce((sum, clip) => sum + Math.max(0, Number(clip.end) - Number(clip.start)), 0);
    const strip = el("div", "timeline-scale");
    clips.forEach((clip, index) => {
      const segment = makeButton(String(index + 1).padStart(2, "0"), "timeline-segment", () => { if (montageVideo) seekVideo(montageVideo, clip.output_start ?? clips.slice(0, index).reduce((sum, item) => sum + Number(item.end) - Number(item.start), 0)); else openSourceAt(clip.start); });
      segment.style.flex = String(Math.max(.001, Number(clip.end) - Number(clip.start)));
      segment.title = `${clip.title || `片段 ${index + 1}`} · 原片 ${spanTime(clip.start, clip.end)}`; strip.append(segment);
    }); container.append(strip);
    const labels = el("div", "timeline-labels"); append(labels, el("span", "", independent ? `${clips.length} 个独立区间` : "00:00"), el("span", "", `${formatSeconds(total, 2)} 秒${independent ? "表情素材" : "精选"}`)); container.append(labels);
    const list = el("div", "timeline-list");
    clips.forEach((clip, index) => {
      const row = el("div", "timeline-row"); row.append(el("span", "timeline-index", String(index + 1).padStart(2, "0")));
      const info = el("div"); append(info, el("h4", "", clip.title || `片段 ${index + 1}`), el("p", "", clip.reason || ""));
      if (clip.output_start !== undefined && clip.output_end !== undefined) info.append(el("span", "output-time", `成片 ${spanTime(clip.output_start, clip.output_end)}`));
      if (clip.frame_ids?.length) info.append(el("span", "output-time", `证据帧 ${clip.frame_ids.join(" · ")}`));
      const button = makeButton(`原片 ${spanTime(clip.start, clip.end)} ↗`, "time-button", () => openSourceAt(clip.start));
      append(row, info, button); list.append(row);
    }); container.append(list);
    if (Number.isFinite(Number(sourceDuration))) { const p = el("p", "field-help", `原视频总长 ${timecode(sourceDuration)}；剪点使用原视频时间，不改变播放速度。`); container.append(p); }
    return container;
  }

  function renderMemes(job) {
    const root = $("memes-content"); root.replaceChildren(); const memes = job.result?.memes || [];
    if (!memes.length) { root.append(placeholder("一秒小表情，也可以单独收藏。", isRecovery(job) ? "本次复用原任务保存的表情包区间；尚无可导出结果，请查看历史 AI 返回与本地恢复记录。不会再次调用 AI。" : job.status === "completed" ? "本次没有返回可导出的表情包，请查看 AI 原始返回与警告。" : "AI 选出表情包区间后，程序会生成可下载的循环 GIF 与短视频。")); return; }
    const heading = el("div", "section-title-row"); const text = el("div"); append(text, el("h3", "", "让这一小秒，多可爱几次。"), el("p", "", "循环仅出现在独立表情包里，不重复放进吃播精选。")); heading.append(text); root.append(heading);
    const grid = el("div", "memes-grid");
    memes.forEach((meme, index) => {
      const card = el("article", "meme-card"); const preview = el("div", "meme-preview");
      if (safeUrl(meme.gif_url)) { const image = el("img"); image.src = safeUrl(meme.gif_url); image.alt = meme.title || `表情包 ${index + 1}`; image.loading = "lazy"; preview.append(image); }
      else { const video = videoPlayer(meme.video_url); if (video) { video.loop = true; preview.append(video); } }
      preview.append(el("span", "meme-loop-label", "ORIGINAL SPEED / LOOP"));
      const body = el("div", "meme-body"); append(body, el("h3", "", meme.title || `小表情 ${index + 1}`), el("p", "", meme.reason || ""), el("span", "meme-source", `原片 ${spanTime(meme.start, meme.end)} · ${formatSeconds(Number(meme.end) - Number(meme.start), 2)} 秒`));
      const downloads = el("div", "meme-downloads"); append(downloads, link("下载 GIF ↗", meme.gif_url, "text-button", true), link("下载 MP4 ↗", meme.video_url, "text-button", true), makeButton("看原片", "text-button", () => openSourceAt(meme.start))); body.append(downloads); append(card, preview, body); grid.append(card);
    }); root.append(grid); root.append(makeTimeline(memes, job.source?.duration, null, "表情包时间轴", true));
  }

  function getEvidence(job) {
    const sheets = job.sampling?.sheets || [];
    const sampled = job.sampling?.frames || sheets.flatMap((sheet) => sheet.frames || []);
    let selected = job.result?.selected_frames || sampled.filter((frame) => frame.selected || frame.meme_selected);
    if (!selected.length && job.status === "failed" && Array.isArray(job.ai?.parsed?.selected_frames)) {
      const sampleMap = new Map(sampled.map((frame) => [frame.frame_id || frame.id, frame]));
      selected = job.ai.parsed.selected_frames.filter((frame) => sampleMap.has(frame.frame_id || frame.id)).map((frame) => ({ ...sampleMap.get(frame.frame_id || frame.id), ...frame }));
    }
    const selectedMap = new Map(selected.map((frame) => [frame.frame_id || frame.id, frame]));
    const allFrames = sampled.map((frame) => ({ ...frame, ...(selectedMap.get(frame.frame_id || frame.id) || {}) }));
    return { sheets, frames: selected, allFrames, count: job.sampling?.frame_count, interval: job.sampling?.interval ?? job.options?.sample_interval, source: job.source };
  }
  function renderEvidence(job, legacy = false) {
    const root = $("evidence-content"); root.replaceChildren();
    const recovered = !legacy && isRecovery(job);
    const evidence = legacy ? { sheets: job.sheets || [], frames: job.selected_frames || [], count: null, interval: null, source: null } : getEvidence(job);
    if (!evidence.sheets.length) { root.append(placeholder(recovered ? "复用的历史证据" : "AI 看过的图，一张也不藏。", recovered ? `${recoveryMessage(job)}当前恢复记录没有可显示的历史拼图；不会为补图发起新的 AI 请求。` : "抽帧与拼图生成后，这里会显示实际发送图片；识别后可切换到圈选版本。")); return; }
    const top = el("div", "evidence-top"); const text = el("div"); append(text, el("h3", "", legacy ? "上一次，它选中了这些。" : recovered ? "复用的原始拼图与历史选帧。" : "本轮整理的输入拼图与选帧。"));
    text.append(el("p", "", legacy ? "历史原始拼图与峰值圈选，非本次生成；圈的是上次选择的峰值最近采样帧，不是所有剪辑覆盖帧。" : `共 ${evidence.count ?? "—"} 个抽样帧 / ${evidence.sheets.length} 张拼图 / 每张最多 60 帧。间隔 ${formatSeconds(evidence.interval)} 秒，不是全部原始帧。`));
    if (!legacy) text.append(el("p", "", recovered ? `${recoveryMessage(job)}本次发送 0 张拼图，视觉请求 0 次；下方仅展示来源任务的历史证据。点击拼图放大后，再点具体画面可以评价。` : `全部拼图用于同一个请求。视觉请求尝试次数：${job.ai?.call_count ?? 0}；尝试不保证送达或已被模型理解。点击拼图放大后，再点具体画面可以评价。`));
    if (!legacy && job.status === "failed" && job.ai?.parsed) text.append(el("p", "error-text", recovered ? "本次恢复失败：复用的是原任务已保存的 AI 选择，不代表本次已通过校验或已经剪入成片。" : "本轮失败：这里也保留模型原始提议，不代表通过校验或已经剪入成片。"));
    const toggle = el("div", "segmented-control"); toggle.setAttribute("role", "group"); toggle.setAttribute("aria-label", "拼图显示方式");
    [[true, recovered ? "历史选帧圈选" : "AI 圈选"], [false, recovered ? "来源原图" : "输入原图"]].forEach(([value, label]) => { const button = makeButton(label, "", () => { state.circled = value; renderEvidence(job, legacy); }); button.setAttribute("aria-pressed", String(state.circled === value)); toggle.append(button); });
    append(top, text, toggle); root.append(top);
    const grid = el("div", "sheet-grid");
    evidence.sheets.forEach((sheet, index) => {
      const card = el("article", "sheet-card"); const original = sheet.original_url || sheet.url; const annotated = sheet.annotated_url; const shown = state.circled && annotated ? annotated : original;
      const title = sheet.title || `拼图 ${String(sheet.index ?? index + 1).padStart(2, "0")}`;
      const description = state.circled && annotated ? recovered ? "依据原任务历史选择圈出；本次未请求 AI，来源原图没有被改写。" : "AI 选中帧已圈出；原图没有被改写。" : legacy ? "历史原始拼图。" : recovered ? "来源任务的历史原始拼图；本次未发送给 AI。" : "本轮请求使用的原始拼图；请求失败不代表模型已收到。";
      const sheetFrames = legacy ? [] : evidence.allFrames.filter((frame) => frame.sheet_id === sheet.id);
      const imageButton = makeButton("", "sheet-image-button", () => openImage(shown, title, description + (!legacy ? " 点击图内任意帧打开反馈详情；点击本身不会修改评价。" : ""), legacy ? null : { jobId: job.id, sheet, frames: sheetFrames }));
      const image = el("img"); const imageUrl = safeUrl(shown); if (imageUrl) image.src = imageUrl; image.alt = `${title}，${state.circled && annotated ? "圈选版" : "原图"}`; image.loading = "lazy";
      append(imageButton, image, el("span", "expand-label", "放大查看 ↗")); card.append(imageButton);
      const info = el("div", "sheet-info"); append(info, el("strong", "", title), el("p", "", `${sheet.count ?? sheet.frames?.length ?? "—"} 帧${sheet.selected_count !== undefined ? ` · 选中 ${sheet.selected_count}` : ""}${state.circled && !annotated ? recovered ? " · 尚无恢复圈选图" : " · 等待 AI 结果圈选" : ""}`));
      if (sheet.sha256) { const hash = el("span", "sheet-hash", `SHA256 ${sheet.sha256}`); hash.title = sheet.sha256; info.append(hash); }
      card.append(info); grid.append(card);
    }); root.append(grid);
    const legend = el("div", "evidence-legend"); const item = el("span"); append(item, el("i", "legend-circle"), el("span", "", legacy ? "上次选中的峰值帧" : "AI 选中帧（以图内标注为准）")); legend.append(item); legend.append(el("span", "", "原图和圈选图分别保留，可独立下载")); root.append(legend);
    if (!legacy) {
      const filters = el("div", "frame-filter-bar"); const group = el("div", "segmented-control"); group.setAttribute("role", "group"); group.setAttribute("aria-label", "查看 AI 选中或全部抽样帧");
      [["selected", `AI 选中 ${evidence.frames.length}`], ["all", `全部抽样 ${evidence.allFrames.length}`]].forEach(([value, label]) => { const button = makeButton(label, "", () => { state.evidenceMode = value; clearSourceVideo(); renderEvidence(job); }); button.dataset.evidenceFilter = value; button.setAttribute("aria-pressed", String(state.evidenceMode === value)); group.append(button); }); append(filters, group, el("p", "field-help", "想补漏选的好画面？切到全部抽样。未标记保持中性，不会当作负例。")); root.append(filters);
    }
    const visibleFrames = !legacy && state.evidenceMode === "all" ? evidence.allFrames : evidence.frames;
    if (visibleFrames.length) {
      const title = el("div", "section-title-row"); const titleText = el("div"); append(titleText, el("h3", "", `${!legacy && state.evidenceMode === "all" ? "全部抽样画面" : "选中的具体画面"} · ${visibleFrames.length} 帧`), el("p", "", "时间、理由和分数均保留；分数表示模型筛选偏好，不代表客观可爱程度。")); title.append(titleText); root.append(title);
      const frames = el("div", "frames-grid");
      visibleFrames.forEach((frame) => {
        const card = el("article", "selected-frame"); const id = frame.frame_id || frame.id || "";
        card.dataset.frameId = id;
        const frameUrl = safeUrl(frame.url);
        if (frameUrl) { const picture = makeButton("", "frame-picture", () => legacy ? openImage(frameUrl, `${id} · ${timecode(frame.time)}`, frame.reason || "历史选择画面") : openFrameDetail(frame, job.id)); const image = el("img"); image.src = frameUrl; image.alt = `${id} 原片 ${timecode(frame.time)}`; image.loading = "lazy"; append(picture, image, el("span", "frame-number", id)); if (frame.score !== undefined) picture.append(el("span", "frame-score", `${frame.score} / 100`)); card.append(picture); }
        const info = el("div", "frame-text"); info.append(makeButton(`${timecode(frame.time)} ↗`, "text-button", () => openSourceAt(frame.time)));
        if (!frameUrl) info.append(el("span", "frame-number-inline", id));
        if (frame.title) info.append(el("p", "good-text", frame.title));
        info.append(el("p", "", frame.reason || (legacy ? "未附理由" : "本轮未附选择理由；可标记喜欢来补漏选。")));
        if (frame.labels?.length) { const labels = el("div", "frame-labels"); frame.labels.forEach((label) => labels.append(el("span", "", label))); info.append(labels); }
        if (!legacy && job.comparison) { const labels = el("div", "frame-differences"); [["added_frame_ids", "新增"], ["removed_frame_ids", "本轮移除"], ["kept_frame_ids", "保留"], ["liked_omitted_ids", "喜欢但仍漏选"]].forEach(([key, label]) => { if (job.comparison[key]?.includes(id)) labels.append(el("span", "", label)); }); info.append(labels); }
        if (!legacy) info.append(voteControls(frame, job.id));
        card.append(info); frames.append(card);
      }); root.append(frames);
    } else root.append(el("p", "field-help", "输入图已生成，尚未获得 AI 选中帧。没有圈选不等于已经完成判断。"));
    if (!legacy && safeUrl(evidence.source?.video_url)) root.append(makeSourcePreview(evidence.source.video_url));
  }

  function makeSourcePreview(url) {
    const details = el("details", "source-preview"); details.id = "source-preview"; details.append(el("summary", "", "展开原视频，核对选中时间点 ↗"));
    const video = videoPlayer(url); if (video) { video.id = "source-video"; details.append(video); state.sourceVideo = video; }
    return details;
  }
  function openSourceAt(time) {
    if (state.mode === "legacy") { toast(`历史原片时间：${timecode(time)}。历史接口未提供原片播放链接，可对照圈选图。`); return; }
    const url = state.job?.source?.video_url;
    if (!safeUrl(url)) { toast(`原片 ${timecode(time)}；原视频尚未就绪。`); return; }
    setTab("evidence"); const details = $("source-preview");
    if (details) { details.open = true; seekVideo(state.sourceVideo, time); details.scrollIntoView({ behavior: "smooth", block: "center" }); }
  }
  function openImage(url, title, description, sheetContext = null) {
    const src = safeUrl(url); if (!src) { toast("这张图尚未生成。"); return; }
    state.dialogSheet = sheetContext;
    $("dialog-image").classList.toggle("sheet-interactive", Boolean(sheetContext));
    $("image-dialog-title").textContent = title; $("image-dialog-description").textContent = description || ""; $("dialog-image").src = src; $("dialog-image").alt = title; $("dialog-download").href = src;
    $("image-dialog").showModal();
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); toast("已复制"); }
    catch { toast("浏览器未允许复制，可选中文本后手动复制。"); }
  }
  function codeSection(title, content, description = "", dark = false) {
    const section = el("section", "request-section"); const heading = el("div", "section-title-row"); append(heading, el("h3", "", title), makeButton("复制", "text-button copy-button", () => copyText(content))); section.append(heading);
    if (description) section.append(el("p", "", description));
    const pre = el("pre", `code-box${dark ? " raw" : ""}`, content); pre.tabIndex = 0; section.append(pre); return section;
  }
  function renderRequest(job) {
    const root = $("request-content"); root.replaceChildren(); const recovered = isRecovery(job);
    const meta = el("div", "debug-meta");
    [recovered ? "本次视觉请求：0 次（本地恢复）" : `视觉请求尝试 ${job.ai?.call_count ?? 0} / 1`, job.ai?.model ? `${recovered ? "来源模型" : "模型"} ${job.ai.model}` : "模型尚未调用", `精选目标 ${job.options?.target_duration ?? "—"} 秒`, `允许 ${job.options?.min_duration ?? "—"}–${job.options?.max_duration ?? "—"} 秒`].forEach((label) => meta.append(el("span", "", label)));
    if (recovered && Number.isInteger(job.recovery?.source_ai_call_count)) meta.append(el("span", "", `来源任务 AI 请求：${job.recovery.source_ai_call_count} 次（历史）`));
    const requestStage = hasTimings(job) && Array.isArray(job.timings.stages) ? job.timings.stages.find((stage) => stage?.id === "ai_request") : null;
    const aiSeconds = !recovered && requestStage && !["pending", "skipped"].includes(requestStage.status) ? measuredSeconds(requestStage.seconds) : null;
    if (aiSeconds !== null) meta.append(el("span", "", `AI 调用${requestStage.status === "running" ? "已用" : "用时"} ${formatElapsed(aiSeconds)}`));
    else if (oldAiSeconds(job) !== null) meta.append(el("span", "", `AI 调用（旧记录） ${formatElapsed(oldAiSeconds(job))}`));
    root.append(meta);
    if (recovered) {
      root.append(codeSection("本地恢复来源 · 没有新 AI 请求", jsonText(job.recovery || { source_job_id: recoverySource(job), no_ai_calls: true }), `${recoveryMessage(job)}来源响应哈希、失败阶段和请求记录属于原任务，不是本次新请求。`));
      if (job.recovery?.source_ai_usage) root.append(codeSection("来源任务 AI 用量（历史，非本次）", jsonText(job.recovery.source_ai_usage), "只作历史溯源；本次没有新增 AI 用量，不把来源消耗或等待时间计入本次。"));
    }
    if (job.prompt?.system !== undefined || job.prompt?.user !== undefined) {
      root.append(codeSection(recovered ? "原任务历史 · System Prompt" : "实际发送 · System Prompt", job.prompt?.system || "（空）", recovered ? `来源任务 ${recoverySource(job) || "未记录"} 保存的历史发送文本；本次未发送，不是本次新请求。` : "下方是本次保存的真实文本，不是运行前的模板。"));
      root.append(codeSection(recovered ? "原任务历史 · User Prompt" : "实际发送 · User Prompt", job.prompt?.user || "（空）", recovered ? "原任务保存的目标时长、采样和帧编号映射，仅作历史证据；本次未发送任何图片或 Prompt。" : "包含本次目标时长、范围、采样信息和帧编号映射；图片附件见「AI 看到了什么」。"));
    } else {
      root.append(placeholder(recovered ? "历史 Prompt 未附在此记录中。" : "发送前，指令也要看得见。", recovered ? "本次只复用已保存结果，没有新请求；不会补造或重新发送缺失的历史 Prompt。" : "完整 Prompt 会在抽样完成、实际调用 AI 前保存到这里。左侧可以查看并编辑当前模板与目标时长。"));
      if (job.options) root.append(codeSection(recovered ? "本次本地恢复选项" : "本次提交的选项", jsonText(job.options)));
    }
    if (job.ai?.raw_response !== undefined) root.append(codeSection(recovered ? "复用的 AI 原始返回（历史）" : "AI 原始返回", jsonText(job.ai.raw_response), recovered ? "原任务保存的真实模型原文；本次复用该返回，仅重做确定性的本地处理，没有新模型响应。" : "这是模型返回的原文；解析错误也会保留，不会用另一轮看图悄悄重试。", true));
    if (job.ai?.parsed) root.append(codeSection(recovered ? "复用的 AI 决策（历史）" : "解析后的 AI 决策", jsonText(job.ai.parsed), recovered ? "原任务已保存的模型选择；与本次本地处理后的时间轴分开保留。" : "模型原始选择与程序调整后的时间轴分开保留。"));
    if (job.ai?.request_manifest) root.append(codeSection(recovered ? "原任务历史请求清单" : "请求清单", jsonText(job.ai.request_manifest), recovered ? "原请求的脱敏历史证据，包含其中的图片数量也属于来源任务；本次未发送，不代表恢复时又提交了请求。不含密钥或图片 Base64。" : "仅展示脱敏清单，不含密钥或图片 Base64。"));
    if (job.feedback) root.append(codeSection(recovered ? "来源任务使用的反馈 · 历史快照" : "本轮实际使用的反馈 · 冻结快照", jsonText(job.feedback), recovered ? "原任务决策的历史依据，不是本次向 AI 发送的反馈；页面中正在修改的草稿另行保存。" : "这是创建本轮时固定的反馈，不是页面上正在修改的下一轮草稿。反馈只用于同一视频，并非训练模型。"));
    if (job.prompt_standard) root.append(codeSection(recovered ? "来源任务实际采用的 Prompt 来源" : "本任务实际采用的 Prompt 来源", jsonText(job.prompt_standard), recovered ? "沿用原任务已冻结的 Prompt 来源，不代表恢复时重新采用今天的生效标准或发起调用。" : job.prompt_standard.mode === "global" ? "这是创建任务时冻结的通用标准版本；今天切换生效版不会改写它。" : "本次自定义指令；没有将它自动发布到全局标准。"));
    if (job.comparison) root.append(codeSection(recovered ? "来源任务与其上一版的选帧变化（历史）" : "与上一版的选帧变化", jsonText(job.comparison), "显示新增、移除、保留和仍未满足的反馈，不转换成准确率。"));
    if (job.result?.validation) root.append(codeSection("剪辑技术检查", jsonText(job.result.validation)));
    if (hasTimings(job)) {
      root.append(codeSection("完整耗时记录", jsonText(job.timings), "这是本次服务端计时快照；下载文件为最近一次持久化记录，不用浏览器时间补算。"));
      append(root, link("下载 timings.json ↗", timingsDownload(job), "text-button", true));
    }
  }

  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
  function startPolling() { stopPolling(); if (!state.job || terminal.has(state.job.status)) return; state.pollTimer = setTimeout(pollJob, 1200); }
  async function pollJob() {
    if (!state.job || state.polling) return;
    const id = state.job.id; state.polling = true;
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
      if (state.job?.id === id) {
        if (state.mode === "job") renderJob(job);
        else { state.job = job; updateGenerateButton(); if (terminal.has(job.status)) { loadJobs(); toast(`当前生成任务${statusNames[job.status] || job.status}，可从「最近的调试」打开。`); } }
      }
    }
    catch (error) { toast(`进度暂时无法更新：${error.message}。不会重新提交 AI 请求。`); }
    finally { state.polling = false; if (state.job?.id === id && !terminal.has(state.job.status)) startPolling(); }
  }
  async function openJob(id) {
    try { stopPolling(); const job = await api(`/api/jobs/${encodeURIComponent(id)}`); state.legacy = null; state.tab = "highlight"; state.file = null; $("video-file").value = ""; $("file-label").textContent = job.filename || "当前任务原片"; $("file-description").textContent = "反馈重选会复用本任务原片，不需重传；点击可选择新视频。"; renderJob(job, true); startPolling(); }
    catch (error) { toast(error.message); }
  }
  async function cancelJob() {
    if (!state.job || terminal.has(state.job.status)) return;
    $("cancel-job").disabled = true;
    try { const job = await api(`/api/jobs/${encodeURIComponent(state.job.id)}/cancel`, { method: "POST" }); renderJob(job); startPolling(); }
    catch (error) { toast(error.message); }
    finally { $("cancel-job").disabled = false; }
  }
  async function loadJobs() {
    try {
      const response = await api("/api/jobs"); const jobs = response.jobs || []; state.jobs = jobs; renderPromptSources(); const list = $("recent-jobs"); list.replaceChildren(); show($("recent-section"), jobs.length > 0);
      jobs.slice(0, 6).forEach((job) => {
        const button = makeButton("", "recent-job", () => openJob(job.id)); button.dataset.status = job.status;
        const info = el("span"); info.append(el("span", "recent-filename", job.filename || job.id));
        let date = ""; if (job.created_at) { const parsed = new Date(job.created_at); if (!Number.isNaN(parsed.getTime())) date = parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }); }
        info.append(el("span", "recent-date", date)); append(button, info, el("span", "recent-job-state", statusNames[job.status] || job.status)); list.append(button);
      });
    } catch { /* Recent-history failure must not prevent a new run. */ }
  }
  async function loadLegacy() {
    try { const response = await api("/api/legacy"); state.legacyRuns = response.runs || []; show($("legacy-shortcut"), state.legacyRuns.length > 0); }
    catch { show($("legacy-shortcut"), false); }
  }
  function openLegacy() {
    const legacy = state.legacyRuns?.[0]; if (!legacy) return;
    state.mode = "legacy"; state.legacy = legacy; clearSourceVideo(); resetTimingsPanel();
    renderSatisfiedRound();
    show($("feedback-panel"), false); $("iterations-panel").replaceChildren(); show($("iterations-panel"), false); state.dialogSheet = null; state.inspectedFrame = null;
    if ($("frame-dialog").open) $("frame-dialog").close(); if ($("image-dialog").open) $("image-dialog").close();
    ["target-duration", "target-slider", "min-duration", "max-duration", "prompt-template", "sample-interval"].forEach((id) => { $(id).disabled = false; });
    show($("empty-state"), false); show($("results"), true); show($("job-status"), false);
    $("workspace-title").textContent = legacy.title || "上一次的 12 秒，重新看看。";
    $("workspace-description").textContent = "历史结果回看 · 不是本次生成，不会调用 AI。";
    $("workspace-badge").textContent = "HISTORICAL RUN"; $("workspace-badge").className = "workspace-badge";
    notice(`${legacy.notice || "这是上一次的历史剪辑和原始拼图。圈选位置是已保存峰值的最近采样帧。"}\n此虚拟历史记录缺少可复用的精确源记录，本版不支持反馈重选；请打开正常生成任务。`);
    const highlight = $("highlight-content"); highlight.replaceChildren();
    if (legacy.video_url) { const screen = el("div", "video-screen"); const video = videoPlayer(legacy.video_url); if (video) screen.append(video); highlight.append(screen); append(highlight, link("下载历史精选 MP4 ↗", legacy.video_url, "text-button", true)); if (legacy.timeline?.length) highlight.append(makeTimeline(legacy.timeline, null, video, "历史精选时间轴")); }
    else highlight.append(placeholder("历史样例", "该历史记录没有可播放成片，但原始拼图与圈选证据仍可查看。"));
    $("memes-content").replaceChildren(placeholder("这是历史回看，不是新生成。", "本次历史接口只回看旧视频、拼图与峰值圈选。新生成的表情包会出现在新任务中。"));
    renderEvidence(legacy, true);
    $("request-content").replaceChildren(placeholder("不补造过去的 Prompt。", "这里只展示历史已经留存的材料。新任务会保留实际发送的 Prompt、全部附件和 AI 原始返回。"));
    $("highlight-count").textContent = legacy.timeline?.length || ""; $("meme-count").textContent = ""; $("sheet-count").textContent = legacy.sheets?.length || "";
    setTab("evidence"); startPolling();
  }
  async function healthCheck() {
    try { const health = await api("/api/health"); $("service-status").textContent = health.ok && health.ffmpeg && health.ffprobe ? "本地服务已连接 · 媒体工具就绪" : "本地已连接 · 请检查媒体工具"; }
    catch { $("service-status").textContent = "本地服务未连接"; }
  }

  $("generate-form").addEventListener("submit", submitJob);
  $("video-file").addEventListener("change", (event) => selectFile(event.target.files?.[0]));
  const zone = $("drop-zone");
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", (event) => selectFile(event.dataTransfer?.files?.[0]));
  $("target-slider").addEventListener("input", () => { $("target-duration").value = $("target-slider").value; updateOptionsPreview(); });
  $("target-duration").addEventListener("input", () => { $("target-slider").value = $("target-duration").value; updateOptionsPreview(); });
  ["min-duration", "max-duration", "sample-interval"].forEach((id) => $(id).addEventListener("input", updateOptionsPreview));
  $("prompt-template").addEventListener("input", () => { state.promptDirty = true; state.promptMode = "custom"; renderPromptMode(); });
  $("reset-prompt").addEventListener("click", useActivePrompt);
  $("use-active-prompt").addEventListener("click", useActivePrompt);
  $("refresh-prompt-library").addEventListener("click", loadPromptLibrary);
  ["standard-editor", "standard-name"].forEach((id) => $(id).addEventListener("input", () => { if (!state.standardDraft || standardLocked()) return; const draft = state.standardDraft; draft.text = $("standard-editor").value; draft.name = $("standard-name").value; draft.dirty = draft.text !== draft.baseline || Boolean(draft.name.trim()) || Boolean(draft.proposalId); $("confirm-standard-publish").checked = false; renderPromptLibrary(); }));
  $("confirm-standard-publish").addEventListener("change", renderPromptLibrary);
  $("edit-active-standard").addEventListener("click", () => { if (standardLocked()) return; resetStandardDraft(); state.libraryMessage = "已明确用生效版替换编辑稿。尚未创建任何新版本，0 次 AI。"; renderPromptLibrary(); });
  $("publish-standard").addEventListener("click", () => mutatePromptLibrary("publish"));
  $("activate-standard").addEventListener("click", () => mutatePromptLibrary("activate"));
  $("add-current-prompt-source").addEventListener("click", () => state.mode === "job" && state.job && addPromptSource(state.job.id));
  $("add-prompt-source").addEventListener("click", () => addPromptSource($("prompt-source-job").value));
  $("refresh-prompt-sources").addEventListener("click", refreshPromptSources);
  $("generate-prompt-proposal").addEventListener("click", createPromptProposal);
  $("prepare-satisfied-standard").addEventListener("click", prepareSatisfiedRound);
  $("create-satisfied-proposal").addEventListener("click", createSatisfiedProposal);
  $("clear-satisfied-round").addEventListener("click", () => { if (standardLocked() || state.sourceBusy) return; state.satisfiedRound = null; renderPromptLibrary(); });
  $("feedback-to-prompt").addEventListener("click", async () => { if (state.mode !== "job" || !state.job) return; $("prompt-library-panel").open = true; await addPromptSource(state.job.id); $("prompt-library-panel").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("save-config").addEventListener("click", saveConfig); $("cancel-job").addEventListener("click", cancelJob); $("refresh-jobs").addEventListener("click", loadJobs); $("legacy-shortcut").addEventListener("click", openLegacy);
  $("feedback-note").addEventListener("input", () => { if (state.mode !== "job" || !state.job || draftLocked(state.job.id)) return; const draft = feedbackDraft(state.job.id); draft.note = $("feedback-note").value; touchDraft(draft); refreshFeedback(state.job.id); });
  $("save-feedback").addEventListener("click", () => state.job && saveFeedback(state.job.id));
  $("revise-feedback").addEventListener("click", reviseFeedback);
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      const tabs = [...document.querySelectorAll("[data-tab]")]; let index = tabs.indexOf(button);
      if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else return;
      event.preventDefault(); setTab(tabs[index].dataset.tab, true);
    });
  });
  $("close-dialog").addEventListener("click", () => $("image-dialog").close());
  $("close-frame-dialog").addEventListener("click", () => $("frame-dialog").close());
  $("frame-dialog-source").addEventListener("click", () => { const context = state.inspectedFrame; if (!context) return; const time = context.frame.time; $("frame-dialog").close(); if ($("image-dialog").open) $("image-dialog").close(); openSourceAt(time); });
  $("frame-dialog").addEventListener("close", () => { state.inspectedFrame = null; if (state.mode === "job" && state.job) { clearSourceVideo(); renderEvidence(state.job); } });
  $("dialog-image").addEventListener("click", handleSheetFrameClick);
  $("image-dialog").addEventListener("click", (event) => { if (event.target === $("image-dialog")) { const rect = $("image-dialog").getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $("image-dialog").close(); } });
  $("image-dialog").addEventListener("close", () => { $("dialog-image").removeAttribute("src"); state.dialogSheet = null; });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.mode === "job" && state.job && !terminal.has(state.job.status)) { stopPolling(); pollJob(); } });
  updateOptionsPreview(); updateGenerateButton();
  renderPromptLibrary();
  Promise.allSettled([loadConfig(), loadJobs(), loadLegacy(), healthCheck(), loadPromptLibrary()]).then(() => {
    let linkedJob;
    try { linkedJob = new URL(window.location.href).searchParams.get("job"); } catch { return; }
    if (linkedJob && /^[0-9a-f]{12}$/.test(linkedJob)) openJob(linkedJob);
  });
})();
