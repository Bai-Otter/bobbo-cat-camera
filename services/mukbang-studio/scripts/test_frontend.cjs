"use strict";

// Deterministic, non-visual frontend contract tests. No browser or media opens.
// All API responses below are test-layer fixtures, never production fallbacks.
// Run with Node 18+: node --test scripts/test_frontend.cjs
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const test = require("node:test");

const project = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(project, "web", "index.html"), "utf8");
const script = fs.readFileSync(path.join(project, "web", "app.js"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  constructor(tag = "div", registry = null) {
    this.tagName = tag.toUpperCase();
    this.registry = registry;
    this.children = [];
    this.events = {};
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.value = "";
    this.hidden = false;
    this._text = "";
    this.className = "";
    this.readyState = 1;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      toggle: (value, force) => {
        const selected = force === undefined ? !classes.has(value) : force;
        if (selected) classes.add(value); else classes.delete(value);
        return selected;
      }
    };
  }
  set id(value) { this._id = value; if (this.registry) this.registry[value] = this; }
  get id() { return this._id; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(_) { throw new Error("Unsafe innerHTML assignment in frontend"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this._text = ""; }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name]; }
  removeAttribute(name) { delete this.attrs[name]; }
  get firstElementChild() { return this.children[0]; }
  focus() {}
  scrollIntoView() {}
  showModal() { this.isOpen = true; this.open = true; }
  close() { const wasOpen = this.open; this.isOpen = false; this.open = false; if (wasOpen && this.events.close) this.events.close(); }
  getBoundingClientRect() { return this.testRect || { left: 0, top: 0, width: 600, height: 600 }; }
  play() { return Promise.resolve(); }
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].join(" ");
}

function descendants(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => descendants(child, predicate))];
}

function withClass(node, className) { return descendants(node, (child) => String(child.className || "").split(" ").includes(className)); }

function legacyFixture() {
  return { runs: [{ id: "test-history", title: "测试历史", video_url: "/api/legacy/files/test/video.mp4", sheets: [{ id: "old", original_url: "/api/legacy/files/test/original.jpg", annotated_url: "/api/legacy/files/test/circled.jpg", count: 60 }], selected_frames: [], timeline: [] }] };
}

function harness({ config, jobs = [], job, postJob = job, legacy = { runs: [] }, feedback, feedbackByJob = {}, route, versions, library, proposals = [], postProposal }) {
  const nodes = {};
  ids.forEach((id) => { nodes[id] = new Element("div", nodes); nodes[id].id = id; });
  const values = { "target-duration": "40", "target-slider": "40", "min-duration": "30", "max-duration": "50", "sample-interval": "1", "api-style": "chat_completions" };
  Object.entries(values).forEach(([id, value]) => { nodes[id].value = value; });
  nodes["sample-interval"].options = ["1", "0.5", "2", "3"].map((value) => ({ value }));
  nodes["generate-button"].append(new Element("span"), new Element("span"));
  nodes["progress-bar"].append(new Element("span"));
  nodes["timings-panel"].hidden = true;
  const tabs = ["highlight", "memes", "evidence", "request"].map((name) => {
    nodes[`tab-${name}`].dataset.tab = name;
    return nodes[`tab-${name}`];
  });
  const calls = [];
  const timers = new Map();
  const feedbackRecords = new Map();
  if (job && feedback) feedbackRecords.set(job.id, structuredClone(feedback));
  Object.entries(feedbackByJob).forEach(([id, record]) => feedbackRecords.set(id, structuredClone(record)));
  let promptLibrary = library ? structuredClone(library) : null;
  const proposalRecords = new Map(proposals.map((record) => [record.id, structuredClone(record)]));
  const createdJobs = [];
  let timerId = 0;
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const override = route ? await route(url, options, calls) : undefined;
    if (override) return { ok: (override.status || 200) < 400, status: override.status || 200, headers: { get: () => "application/json" }, json: async () => override.body };
    let data; let status = 200;
    const subresource = url.match(/^\/api\/jobs\/([^/]+)\/(feedback|iterations|revise)$/);
    if (url === "/api/config") data = config;
    else if (url === "/api/prompt-library") { if (!promptLibrary) throw new Error("No prompt-library fixture provided"); data = structuredClone(promptLibrary); }
    else if (["/api/prompt-library/versions", "/api/prompt-library/activate"].includes(url)) {
      const body = JSON.parse(options.body);
      if (body.expected_revision !== promptLibrary.revision) { status = 409; data = { detail: "通用标准版本冲突" }; }
      else { promptLibrary.revision++; if (url.endsWith("/versions")) { const id = `P${String(promptLibrary.versions.length + 1).padStart(4, "0")}`; promptLibrary.versions.push({ id, name: body.name || "测试新标准", text: body.text, parent_version_id: promptLibrary.active_version_id, source_proposal_id: body.proposal_id, diff: "TEST-ONLY COMPUTED DIFF" }); promptLibrary.active_version_id = id; } else promptLibrary.active_version_id = body.version_id; data = structuredClone(promptLibrary); }
    }
    else if (["/api/prompt-proposals", "/api/prompt-proposals/satisfied-round"].includes(url)) {
      const body = JSON.parse(options.body);
      data = postProposal || { id: "Q0001", status: "queued", base_revision: body.expected_revision, base_version_id: promptLibrary.active_version_id, base_prompt: promptLibrary.versions.find((version) => version.id === promptLibrary.active_version_id).text, sources: body.sources, note: body.note, ai: { call_count: 0, text_call_count: 0, visual_call_count: 0 } };
      proposalRecords.set(data.id, structuredClone(data));
    }
    else if (/^\/api\/prompt-proposals\/[^/]+$/.test(url)) { data = proposalRecords.get(decodeURIComponent(url.split("/").pop())); if (!data) throw new Error("Unknown test proposal"); }
    else if (url === "/api/jobs" && options.method === "POST") data = postJob;
    else if (url === "/api/jobs") data = { jobs: [...createdJobs, ...jobs] };
    else if (url === "/api/legacy") data = legacy;
    else if (url === "/api/health") data = { ok: true, ffmpeg: true, ffprobe: true };
    else if (subresource) {
      const id = decodeURIComponent(subresource[1]); const kind = subresource[2];
      const base = [job, postJob, ...jobs].find((item) => item?.id === id) || job;
      if (kind === "iterations") data = { root_job_id: base?.iteration?.root_job_id || id, jobs: versions || [...jobs, ...createdJobs].filter((item, index, array) => array.findIndex((other) => other.id === item.id) === index).map((item) => ({ id: item.id, round: item.iteration?.round || 1, parent_job_id: item.iteration?.parent_job_id, status: item.status, filename: item.filename })) };
      else if (kind === "feedback") {
        const record = feedbackRecords.get(id) || { version: 0, annotations: structuredClone(base?.feedback?.annotations || []), note: base?.feedback?.note || "" };
        if (options.method === "PUT") { const body = JSON.parse(options.body); if (body.expected_version !== record.version) { status = 409; data = { detail: "反馈版本冲突" }; } else { data = { version: record.version + 1, annotations: body.annotations, note: body.note }; feedbackRecords.set(id, data); } }
        else data = record;
      } else { data = postJob; if (data && !createdJobs.some((item) => item.id === data.id)) createdJobs.push(data); }
    }
    else if (/^\/api\/jobs\/[^/]+$/.test(url)) { const id = decodeURIComponent(url.split("/").pop()); data = [job, postJob, ...jobs].find((item) => item?.id === id); if (!data) throw new Error(`Unknown test job: ${id}`); }
    else throw new Error(`Unexpected test request: ${url}`);
    return { ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => data };
  };
  const context = {
    document: { getElementById: (id) => nodes[id] || null, createElement: (tag) => new Element(tag, nodes), querySelectorAll: (selector) => selector === "[data-tab]" ? tabs : [], addEventListener() {} },
    window: { location: { origin: "http://127.0.0.1:8876" }, innerWidth: 1440 },
    fetch, URL, FormData, Blob, console, crypto,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: (callback, milliseconds) => { const id = ++timerId; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { nodes, calls, timers, feedbackRecords, proposalRecords, librarySnapshot: () => structuredClone(promptLibrary), ready: async () => { await tick(); await tick(); }, pollProposal: async () => { const timer = [...timers].find(([, value]) => value.milliseconds === 1500); assert.ok(timer, "No proposal-status poll found"); timers.delete(timer[0]); await timer[1].callback(); }, poll: async () => {
    const timer = [...timers].find(([, value]) => value.milliseconds === 1200);
    assert.ok(timer, "No scheduled server-status poll found");
    timers.delete(timer[0]);
    await timer[1].callback();
  } };
}

const configFixture = () => ({
  configured: true,
  provider: { base_url: "https://example.test/v1", model: "test-vision", api_style: "chat_completions", key_configured: true },
  defaults: { target_duration: 40, min_duration: 30, max_duration: 50, sample_interval: 1 },
  prompt_template: "DEFAULT TEST PROMPT",
  limits: { max_upload_mb: 512 }
});

test("HTML references and self-contained favicon", () => {
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  const dynamicIds = new Set(["source-preview", "source-video"]);
  const missing = [...script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]).filter((id) => !ids.includes(id) && !dynamicIds.has(id));
  assert.deepEqual(missing, []);
  assert.match(html, /rel="icon"[^>]+href="data:image\/svg\+xml,/);
  assert.match(html, /href="\/static\/styles\.css"/);
  assert.match(html, /src="\/static\/app\.js"/);
  assert.doesNotMatch(script, /(?:localStorage|sessionStorage|\.innerHTML\s*=)/);
});

test("duration and edited Prompt reach the multipart API, key input clears, no duplicate generation", async () => {
  const job = { id: "test-queued", filename: "cat.mp4", status: "queued", progress: 0, options: { target_duration: 45, min_duration: 30, max_duration: 50, sample_interval: 1, prompt: "CUSTOM TEST PROMPT" } };
  const { nodes, calls, ready } = harness({ config: configFixture(), job });
  await ready();
  assert.equal(nodes["prompt-template"].value, "DEFAULT TEST PROMPT");
  assert.match(nodes["options-preview"].textContent, /40 秒/);
  nodes["target-duration"].value = "45";
  nodes["target-duration"].events.input();
  assert.equal(nodes["target-slider"].value, "45");
  nodes["prompt-template"].value = "CUSTOM TEST PROMPT";
  nodes["prompt-template"].events.input();
  const file = new Blob(["synthetic-test-video"], { type: "video/mp4" });
  file.name = "cat.mp4";
  nodes["video-file"].events.change({ target: { files: [file] } });
  await nodes["generate-form"].events.submit({ preventDefault() {} });
  // An active job must not accidentally be sent twice.
  await nodes["generate-form"].events.submit({ preventDefault() {} });
  const submissions = calls.filter((call) => call.url === "/api/jobs" && call.options.method === "POST");
  assert.equal(submissions.length, 1);
  assert.deepEqual(JSON.parse(submissions[0].options.body.get("options")), job.options);
  nodes["api-key"].value = "unit-test-only-key";
  await nodes["save-config"].events.click();
  assert.equal(nodes["api-key"].value, "");
  const update = calls.find((call) => call.url === "/api/config" && call.options.method === "PUT");
  assert.equal(JSON.parse(update.options.body).api_key, "unit-test-only-key");
});

test("current GPT relay source and HTTP transport warning survive initialization and save", async () => {
  const config = configFixture();
  config.provider.model = "gpt-6.1-sol";
  config.provider.configuration_source = "codex";
  config.provider.transport_warning = "当前中转使用 HTTP，图片及请求内容在传输中未加密。";
  const { nodes, ready } = harness({ config });
  await ready();
  assert.equal(nodes["model-name"].value, "gpt-6.1-sol");
  assert.match(allText(nodes["config-message"]), /复用当前 GPT 中转配置/);
  assert.match(allText(nodes["config-message"]), /HTTP.*未加密/);
  nodes["api-key"].value = "test-relay-key";
  await nodes["save-config"].events.click();
  assert.equal(nodes["api-key"].value, "");
  assert.match(allText(nodes["config-message"]), /连接配置已保存/);
  assert.match(allText(nodes["config-message"]), /HTTP.*未加密/, "save confirmation must not replace the transport warning");
});

test("completed rendering, both timelines, literal untrusted text and clearly historical review", async () => {
  const untrustedText = "<script>THIS MUST STAY TEXT</script>";
  const frame = { id: "F0001", time: 2, url: "/api/jobs/test/files/frame.jpg", selected: true, score: 96, reason: untrustedText, labels: ["舔嘴"] };
  const job = {
    id: "test", filename: untrustedText, status: "completed", progress: 100,
    options: { target_duration: 40, min_duration: 30, max_duration: 50, sample_interval: 1, prompt: "TEST PROMPT" },
    source: { duration: 180, video_url: "/api/jobs/test/files/source.mp4" },
    sampling: { frame_count: 180, sheet_count: 3, interval: 1, sheets: [{ id: "S1", url: "/api/jobs/test/files/original.jpg", annotated_url: "/api/jobs/test/files/circled.jpg", count: 60 }], frames: [frame] },
    prompt: { system: "system", user: "actual target 40 / min 30 / max 50" },
    ai: { call_count: 1, model: "test", raw_response: untrustedText, parsed: { summary: "TEST SUMMARY" } },
    result: { video_url: "/api/jobs/test/files/highlight.mp4", video_duration: 40,
      clips: [{ id: "C1", start: 1, end: 41, output_start: 0, output_end: 40, title: untrustedText, reason: "test", frame_ids: ["F0001"] }],
      memes: [{ id: "M1", start: 2, end: 3.5, title: "one meme", gif_url: "/api/jobs/test/files/meme.gif", video_url: "/api/jobs/test/files/meme.mp4", frame_ids: ["F0001"] }],
      selected_frames: [frame], validation: { ok: true } }
  };
  const legacy = legacyFixture();
  assert.ok(legacy.runs.length, "Historical fixture is required");
  const { nodes, calls, ready } = harness({ config: configFixture(), jobs: [job], job, legacy });
  await ready();
  await nodes["recent-jobs"].children[0].events.click();
  assert.match(allText(nodes["highlight-content"]), /今天的可爱/);
  assert.match(allText(nodes["highlight-content"]), /精选时间轴/);
  assert.match(allText(nodes["memes-content"]), /表情包时间轴/);
  assert.ok(allText(nodes["evidence-content"]).includes(untrustedText));
  assert.ok(allText(nodes["request-content"]).includes("actual target 40"));
  assert.equal(nodes["workspace-title"].textContent, untrustedText);
  nodes["legacy-shortcut"].events.click();
  assert.match(nodes["workspace-description"].textContent, /不是本次生成/);
  assert.match(allText(nodes["evidence-content"]), /峰值最近采样帧/);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 0, "Read-only review cannot submit a new AI job");
});

const fixtureStageNames = [
  ["upload", "接收与保存"], ["queue", "等待队列"], ["source_probe", "读取源视频"], ["extract_frames", "提取抽样帧"],
  ["build_sheets", "拼图排版"], ["prepare_request", "准备 AI 请求"], ["ai_request", "AI 识别"],
  ["selection", "验证选帧与时间轴"], ["annotate_sheets", "圈选证据图"], ["render_highlight", "渲染精选"],
  ["export_memes", "导出表情包"], ["final_validation", "最终校验"], ["overhead", "其余本地开销"]
];

function timingFixture(overrides = {}) {
  const seconds = [0, 1.25, .004, 3.5, .3, .15, 90, .4, .2, 21, 7.5, .1, .996];
  return {
    schema_version: 1, available: true, status: "completed", total_seconds: 125.4,
    started_at: "2026-10-22T11:00:00+08:00", finished_at: "2026-10-22T11:02:05.400+08:00",
    scope: "server_request_to_terminal", note: "服务端单调时钟记录。",
    stages: fixtureStageNames.map(([id, label], index) => ({ id, label, seconds: seconds[index], status: "completed", percent: seconds[index] / 125.4 * 100 })),
    ...overrides
  };
}

function timingJob(timings, status = "completed") {
  return { id: "timing-test", filename: "synthetic.mp4", status, progress: status === "completed" ? 100 : 30,
    options: { target_duration: 40, min_duration: 30, max_duration: 50, sample_interval: 1, prompt: "TEST ONLY" },
    created_at: "2026-10-22T00:00:00+08:00", updated_at: "2026-10-23T00:00:00+08:00", timings };
}

async function openFixtureJob(job, extra = {}) {
  const run = harness({ config: configFixture(), jobs: [job], job, ...extra });
  await run.ready();
  await run.nodes["recent-jobs"].children[0].events.click();
  await run.ready();
  return run;
}

function timingRow(panel, id) { return descendants(panel, (node) => node.dataset.stageId === id)[0]; }
function timingDetail(row, id) { return descendants(row, (node) => node.dataset.detailId === id)[0]; }

test("timing ledger uses measured server total, zero and tiny fractions; all stages and JSON are inspectable", async () => {
  const job = timingJob(timingFixture());
  const { nodes, calls, timers } = await openFixtureJob(job);
  const panel = nodes["timings-panel"];
  assert.equal(panel.hidden, false);
  assert.equal(withClass(panel, "timing-stage-row").length, 13);
  assert.equal(allText(withClass(panel, "timings-total")[0]).includes("2 分 5.4 秒"), true);
  assert.equal(withClass(timingRow(panel, "upload"), "timing-stage-duration")[0].textContent, "0 秒");
  assert.equal(withClass(timingRow(panel, "upload"), "timing-stage-percent")[0].textContent, "0%");
  assert.equal(withClass(timingRow(panel, "source_probe"), "timing-stage-duration")[0].textContent, "<0.01 秒");
  assert.ok(allText(panel).includes("下载为服务端最近持久化记录"));
  assert.ok(allText(nodes["request-content"]).includes("完整耗时记录"));
  assert.ok(allText(nodes["request-content"]).includes('"total_seconds": 125.4'));
  assert.equal(descendants(panel, (node) => String(node.href || "").endsWith("/api/jobs/timing-test/files/timings.json")).length, 1);
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
  assert.equal([...timers.values()].filter((timer) => timer.milliseconds === 1200).length, 0, "completed jobs cannot need local timing updates");
  assert.ok(html.indexOf('id="timings-panel"') < html.indexOf('id="results"'), "Timing panel must remain outside result tabs");
});

test("timing substeps nest within their parent without adding to totals, percentages or top-level rows", async () => {
  const timings = timingFixture();
  const highlight = timings.stages.find((stage) => stage.id === "render_highlight");
  highlight.details = [
    { id: "encode", label: "编码精选", seconds: 14, status: "completed", percent: 100 * 14 / 21 },
    { id: "metadata", label: "普通信息检查", seconds: .5, status: "completed", percent: 100 * .5 / 21 },
    { id: "frames", label: "逐帧检查", seconds: 3, status: "completed", percent: 100 * 3 / 21 },
    { id: "decode", label: "完整解码", seconds: 3.5, status: "completed", percent: 100 * 3.5 / 21 }
  ];
  timings.stages.find((stage) => stage.id === "export_memes").details = [
    { id: "meme-1-dual", label: "表情包 1 · 同一源双输出 MP4 / GIF", seconds: 7.5, status: "completed", percent: 100 }
  ];
  const before = JSON.stringify(timings);
  const { nodes, calls } = await openFixtureJob(timingJob(timings));
  const panel = nodes["timings-panel"];
  const row = timingRow(panel, "render_highlight");
  assert.equal(withClass(panel, "timing-stage-row").length, 13);
  assert.equal(withClass(panel, "timing-stage-percent").length, 13, "Substeps must not add top-level percentages");
  assert.equal(withClass(panel, "timing-stage-duration").length, 13);
  assert.equal(withClass(panel, "timings-total").length, 1);
  assert.match(allText(withClass(panel, "timings-total")[0]), /2 分 5\.4 秒/);
  assert.equal(withClass(row, "timing-stage-duration")[0].textContent, "21 秒");
  assert.equal(withClass(row, "timing-stage-percent")[0].textContent, "16.7%");
  assert.equal(withClass(panel, "timing-detail-row").length, 5);
  assert.equal(withClass(timingDetail(row, "metadata"), "timing-detail-duration")[0].textContent, "0.5 秒");
  assert.match(allText(row), /编码精选.*普通信息检查.*逐帧检查.*完整解码/);
  assert.match(allText(row), /细项已包含在本环节耗时中，不额外相加/);
  assert.match(allText(timingRow(panel, "export_memes")), /表情包 1 · 同一源双输出 MP4 \/ GIF/);
  assert.equal(JSON.stringify(timings), before, "Rendering must not recalculate or mutate the server ledger");
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
});

test("timing substeps retain actual failed or interrupted work without marking pending work as completed", async () => {
  for (const status of ["failed", "cancelled", "interrupted"]) {
    const timings = timingFixture({ status, is_partial: status === "interrupted", total_seconds: 15 });
    const stage = timings.stages.find((row) => row.id === "render_highlight");
    Object.assign(stage, { status, seconds: 11.25, percent: 75, details: [
      { id: "encode", label: "编码精选", seconds: 10, status: "completed" },
      { id: "frames", label: "逐帧检查", seconds: 1.25, status },
      { id: "decode", label: "完整解码", seconds: 42, status: "pending" },
      { id: "unrecorded", label: "未记录细项", seconds: 5 }
    ] });
    const { nodes } = await openFixtureJob(timingJob(timings, status));
    const row = timingRow(nodes["timings-panel"], "render_highlight");
    assert.equal(withClass(timingDetail(row, "encode"), "timing-detail-state")[0].textContent, "已完成");
    assert.equal(withClass(timingDetail(row, "encode"), "timing-detail-duration")[0].textContent, "10 秒");
    assert.equal(withClass(timingDetail(row, "frames"), "timing-detail-duration")[0].textContent, "1.25 秒");
    assert.ok(["失败", "已取消", "已中断"].includes(withClass(timingDetail(row, "frames"), "timing-detail-state")[0].textContent));
    assert.equal(withClass(timingDetail(row, "decode"), "timing-detail-state")[0].textContent, "未执行");
    assert.equal(withClass(timingDetail(row, "decode"), "timing-detail-duration")[0].textContent, "—");
    assert.equal(withClass(timingDetail(row, "unrecorded"), "timing-detail-state")[0].textContent, "未记录");
    assert.equal(withClass(timingDetail(row, "unrecorded"), "timing-detail-duration")[0].textContent, "—");
    assert.equal(withClass(row, "timing-stage-duration")[0].textContent, "11.25 秒");
    assert.match(allText(withClass(nodes["timings-panel"], "timings-total")[0]), /15 秒/);
  }
});

test("timing substeps remain absent for old or malformed detail records without fabricating breakdowns", async () => {
  for (const details of [undefined, null, [], {}, [null, false, 7, "bad", []]]) {
    const timings = timingFixture();
    if (details !== undefined) timings.stages[9].details = details;
    const { nodes } = await openFixtureJob(timingJob(timings));
    const panel = nodes["timings-panel"];
    assert.equal(withClass(panel, "timing-stage-row").length, 13);
    assert.equal(withClass(panel, "timing-detail-row").length, 0);
    assert.doesNotMatch(allText(panel), /细项已包含|编码精选|同一源双输出/);
    assert.match(allText(withClass(panel, "timings-total")[0]), /2 分 5\.4 秒/);
    assert.equal(withClass(timingRow(panel, "render_highlight"), "timing-stage-duration")[0].textContent, "21 秒");
  }
});

test("timing substeps reject invalid seconds instead of coercing them into elapsed time", async () => {
  for (const seconds of [null, undefined, -1, NaN, Infinity, "5", true]) {
    const timings = timingFixture();
    timings.stages[9].details = [
      { id: "invalid", label: "逐帧检查", seconds, status: "completed" },
      { id: "zero", label: "普通信息检查", seconds: 0, status: "completed" },
      { id: "tiny", label: "完整解码", seconds: .004, status: "completed" }
    ];
    const { nodes } = await openFixtureJob(timingJob(timings));
    const row = timingRow(nodes["timings-panel"], "render_highlight");
    assert.equal(withClass(timingDetail(row, "invalid"), "timing-detail-duration")[0].textContent, "—");
    assert.equal(withClass(timingDetail(row, "zero"), "timing-detail-duration")[0].textContent, "0 秒");
    assert.equal(withClass(timingDetail(row, "tiny"), "timing-detail-duration")[0].textContent, "<0.01 秒");
    assert.doesNotMatch(allText(row), /NaN|Infinity|undefined/);
  }
});

test("timing substeps update only from server polling, not browser-side estimates", async () => {
  const timings = timingFixture({ status: "running", total_seconds: 10, finished_at: null });
  Object.assign(timings.stages[9], { status: "running", seconds: 3, percent: 30, details: [
    { id: "encode", label: "编码精选", seconds: 2.1, status: "running" }
  ] });
  const job = timingJob(timings, "rendering");
  const run = await openFixtureJob(job);
  const panel = run.nodes["timings-panel"];
  assert.equal(withClass(timingDetail(timingRow(panel, "render_highlight"), "encode"), "timing-detail-duration")[0].textContent, "2.1 秒");
  const before = allText(panel);
  job.timings = { ...timings, total_seconds: 10.9, stages: timings.stages.map((stage) => stage.id === "render_highlight" ? {
    ...stage, seconds: 3.9, details: [{ id: "encode", label: "编码精选", seconds: 2.9, status: "running" }]
  } : stage) };
  assert.equal(allText(panel), before);
  await run.poll();
  const row = timingRow(panel, "render_highlight");
  assert.equal(withClass(timingDetail(row, "encode"), "timing-detail-duration")[0].textContent, "2.9 秒");
  assert.equal(withClass(timingDetail(row, "encode"), "timing-detail-state")[0].textContent, "进行中");
  assert.equal(withClass(row, "timing-stage-duration")[0].textContent, "3.9 秒");
});

test("running timings change only on server polling; pending and skipped never appear as zero", async () => {
  const timings = timingFixture({ status: "running", total_seconds: 3.25, finished_at: null });
  timings.stages.forEach((stage) => { stage.status = "pending"; stage.seconds = null; stage.percent = null; });
  Object.assign(timings.stages[0], { status: "completed", seconds: 0, percent: 0 });
  Object.assign(timings.stages[6], { status: "running", seconds: 1.25, percent: 38.5 });
  Object.assign(timings.stages[10], { status: "skipped", seconds: null, percent: null });
  const job = timingJob(timings, "analyzing");
  const run = await openFixtureJob(job);
  const panel = run.nodes["timings-panel"];
  assert.ok(allText(withClass(panel, "timings-total")[0]).includes("3.25 秒"));
  assert.equal(withClass(timingRow(panel, "selection"), "timing-stage-duration")[0].textContent, "—");
  assert.equal(withClass(timingRow(panel, "selection"), "timing-stage-state")[0].textContent, "未执行");
  assert.equal(withClass(timingRow(panel, "export_memes"), "timing-stage-state")[0].textContent, "已跳过");
  assert.equal(withClass(timingRow(panel, "export_memes"), "timing-stage-duration")[0].textContent, "—");
  const before = allText(panel);
  job.timings = timingFixture({ ...timings, total_seconds: 5.5, stages: timings.stages.map((stage) => stage.id === "ai_request" ? { ...stage, seconds: 3.5, percent: 63.6 } : stage) });
  assert.equal(allText(panel), before, "No browser-side ticking before server poll");
  await run.poll();
  assert.ok(allText(withClass(panel, "timings-total")[0]).includes("5.5 秒"));
  assert.equal(withClass(timingRow(panel, "ai_request"), "timing-stage-duration")[0].textContent, "3.5 秒");
  assert.equal(withClass(timingRow(panel, "ai_request"), "timing-stage-percent")[0].textContent, "63.6%");
  assert.equal([...run.timers.values()].every((timer) => timer.milliseconds === 1200), true, "Only normal job polling is scheduled");
  assert.doesNotMatch(script, /performance\.now|Date\.now|setInterval/);
});

test("failed, cancelled and interrupted timing records keep measured work and mark unexecuted stages", async () => {
  for (const status of ["failed", "cancelled", "interrupted"]) {
    const timings = timingFixture({ status, is_partial: status === "interrupted", total_seconds: 8.75 });
    Object.assign(timings.stages[6], { status, seconds: 5.25, percent: 60 });
    for (const stage of timings.stages.slice(7)) Object.assign(stage, { status: "pending", seconds: null, percent: null });
    const { nodes } = await openFixtureJob(timingJob(timings, status));
    const panel = nodes["timings-panel"];
    assert.equal(panel.hidden, false);
    assert.ok(allText(panel).includes("8.75 秒"));
    assert.equal(withClass(timingRow(panel, "ai_request"), "timing-stage-duration")[0].textContent, "5.25 秒");
    assert.ok(["失败", "已取消", "已中断"].includes(withClass(timingRow(panel, "ai_request"), "timing-stage-state")[0].textContent));
    assert.equal(withClass(timingRow(panel, "render_highlight"), "timing-stage-duration")[0].textContent, "—");
    assert.equal(withClass(timingRow(panel, "render_highlight"), "timing-stage-state")[0].textContent, "未执行");
  }
});

test("invalid timing values are not coerced into zero or shown as NaN percentages", async () => {
  for (const invalid of [null, undefined, -1, NaN, Infinity, "5", true]) {
    const timings = timingFixture({ total_seconds: invalid });
    Object.assign(timings.stages[6], { seconds: invalid, percent: invalid });
    const { nodes } = await openFixtureJob(timingJob(timings));
    const panel = nodes["timings-panel"];
    assert.ok(allText(withClass(panel, "timings-total")[0]).includes("未记录"));
    assert.equal(withClass(timingRow(panel, "ai_request"), "timing-stage-duration")[0].textContent, "—");
    assert.equal(withClass(timingRow(panel, "ai_request"), "timing-stage-percent")[0].textContent, "—");
    assert.doesNotMatch(allText(panel), /NaN|Infinity|undefined/);
  }
});

test("old completed record may show only reliable AI time; failed old time is never mislabeled as AI", async () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const job = timingJob(undefined, status); job.ai = { elapsed_seconds: 72.25 };
    const { nodes } = await openFixtureJob(job);
    assert.match(allText(nodes["timings-panel"]), /历史任务未记录完整耗时/);
    assert.equal(withClass(nodes["timings-panel"], "timings-total").length, 0);
    assert.equal(allText(nodes["timings-panel"]).includes("AI 调用（旧记录）"), status === "completed");
    assert.equal(allText(nodes["request-content"]).includes("AI 调用（旧记录）"), status === "completed");
    assert.equal(descendants(nodes["timings-panel"], (node) => String(node.href || "").includes("timings.json")).length, 0);
    assert.equal(allText(nodes["request-content"]).includes("完整耗时记录"), false);
  }
  for (const invalid of [null, -2, NaN, Infinity, "45"]) {
    const job = timingJob(undefined); job.ai = { elapsed_seconds: invalid };
    const { nodes } = await openFixtureJob(job);
    assert.equal(allText(nodes["timings-panel"]).includes("AI 调用（旧记录）"), false);
    assert.equal(allText(nodes["request-content"]).includes("AI 调用（旧记录）"), false);
  }
});

test("legacy and new-upload switches clear the previous job's timing panel", async () => {
  const job = timingJob(timingFixture());
  const postJob = { ...timingJob(timingFixture({ status: "running", total_seconds: 0, finished_at: null }), "queued"), id: "brand-new-timing-job" };
  const { nodes, ready } = await openFixtureJob(job, { postJob, legacy: legacyFixture() });
  assert.ok(allText(nodes["timings-panel"]).includes("2 分 5.4 秒"));
  nodes["legacy-shortcut"].events.click();
  assert.equal(nodes["timings-panel"].hidden, true);
  assert.equal(allText(nodes["timings-panel"]).trim(), "");
  await nodes["recent-jobs"].children[0].events.click();
  assert.ok(allText(nodes["timings-panel"]).includes("2 分 5.4 秒"));
  const file = new Blob(["timing-fixture-only"], { type: "video/mp4" }); file.name = "new-synthetic.mp4";
  nodes["video-file"].events.change({ target: { files: [file] } });
  const submitted = nodes["generate-form"].events.submit({ preventDefault() {} });
  assert.equal(nodes["timings-panel"].hidden, true, "Starting upload must immediately clear old timings");
  await submitted;
  assert.equal(nodes["timings-panel"].hidden, false);
  assert.ok(allText(withClass(nodes["timings-panel"], "timings-total")[0]).includes("0 秒"));
  assert.equal(allText(nodes["timings-panel"]).includes("2 分 5.4 秒"), false);
  await ready();
});

function feedbackJob(id = "feedback-test", overrides = {}) {
  const frames = [
    { id: "F0001", time: 1, sheet_id: "S1", box: [10, 20, 100, 160], url: `/api/jobs/${id}/files/f1.jpg`, selected: true, reason: "全脸的小表情", labels: ["全脸"] },
    { id: "F0002", time: 2, sheet_id: "S1", box: [120, 20, 100, 160], url: `/api/jobs/${id}/files/f2.jpg`, selected: false }
  ];
  return { id, filename: `${id}.mp4`, status: "completed", progress: 100,
    options: { target_duration: 40, min_duration: 30, max_duration: 50, sample_interval: 1, prompt: "BASE PROMPT" },
    source: { duration: 180, video_url: `/api/jobs/${id}/files/source.mp4` },
    sampling: { interval: 1, frame_count: 2, sheet_count: 1, frames, sheets: [{ id: "S1", width: 240, height: 200, count: 2, url: `/api/jobs/${id}/files/sheet.jpg`, annotated_url: `/api/jobs/${id}/files/circled.jpg` }] },
    ai: { call_count: 1, model: "gpt-6.1-sol" }, result: { selected_frames: [frames[0]], clips: [], memes: [] }, ...overrides };
}

function frameFeedback(nodes, id, root = nodes["evidence-content"]) {
  const controls = withClass(root, "frame-feedback").find((node) => node.dataset.frameId === id);
  assert.ok(controls, `Missing feedback controls for ${id}`);
  return { controls, buttons: withClass(controls, "frame-vote-buttons")[0].children, reason: withClass(controls, "frame-feedback-reason")[0] };
}
function selectAllFrames(nodes) { descendants(nodes["evidence-content"], (node) => node.dataset.evidenceFilter === "all")[0].events.click(); }
function editNote(nodes, note) { nodes["feedback-note"].value = note; nodes["feedback-note"].events.input(); }
function feedbackCalls(calls, method = "GET", id = "feedback-test") { return calls.filter((call) => call.url === `/api/jobs/${id}/feedback` && (call.options.method || "GET") === method); }
function reviseCalls(calls) { return calls.filter((call) => call.url.endsWith("/revise") && call.options.method === "POST"); }

test("same-job reopening and status polling preserve unsaved note/reason and fetch feedback only once", async () => {
  const job = feedbackJob();
  const initial = { version: 3, annotations: [{ frame_id: "F0001", label: "like", reason: "原原因" }], note: "服务器备注" };
  const run = await openFixtureJob(job, { feedback: initial, route: (url) => url === `/api/jobs/${job.id}` ? { body: structuredClone(job) } : undefined });
  const { nodes, calls, ready } = run;
  const reason = frameFeedback(nodes, "F0001").reason;
  reason.value = "本地尚未保存的原因"; reason.events.input();
  editNote(nodes, "本地尚未保存的整体备注");
  await nodes["recent-jobs"].children[0].events.click(); await ready();
  assert.equal(nodes["feedback-note"].value, "本地尚未保存的整体备注");
  assert.equal(frameFeedback(nodes, "F0001").reason.value, "本地尚未保存的原因");
  job.status = "analyzing";
  await nodes["recent-jobs"].children[0].events.click(); await ready();
  assert.equal(nodes["feedback-note"].disabled, true);
  await run.poll();
  job.status = "completed";
  await run.poll(); await ready();
  assert.equal(nodes["feedback-note"].disabled, false);
  assert.equal(nodes["feedback-note"].value, "本地尚未保存的整体备注");
  assert.equal(frameFeedback(nodes, "F0001").reason.value, "本地尚未保存的原因");
  assert.equal(feedbackCalls(calls).length, 1, "Polls and same-job reopening must not refetch feedback");
  assert.equal(feedbackCalls(calls, "PUT").length, 0);
  assert.equal(reviseCalls(calls).length, 0);
});

test("drafts remain isolated between videos even when their frame IDs match", async () => {
  const first = feedbackJob("first-video"); const second = feedbackJob("second-video");
  const { nodes, calls, ready } = await openFixtureJob(first, { jobs: [first, second] });
  frameFeedback(nodes, "F0001").buttons[0].events.click(); editNote(nodes, "第一段的草稿");
  await nodes["recent-jobs"].children[1].events.click(); await ready();
  assert.equal(nodes["feedback-note"].value, "");
  assert.equal(frameFeedback(nodes, "F0001").controls.dataset.label, "neutral");
  frameFeedback(nodes, "F0001").buttons[1].events.click(); editNote(nodes, "第二段的草稿");
  await nodes["recent-jobs"].children[0].events.click(); await ready();
  assert.equal(nodes["feedback-note"].value, "第一段的草稿");
  assert.equal(frameFeedback(nodes, "F0001").controls.dataset.label, "like");
  await nodes["recent-jobs"].children[1].events.click(); await ready();
  assert.equal(nodes["feedback-note"].value, "第二段的草稿");
  assert.equal(frameFeedback(nodes, "F0001").controls.dataset.label, "dislike");
  assert.equal(feedbackCalls(calls, "GET", first.id).length, 1);
  assert.equal(feedbackCalls(calls, "GET", second.id).length, 1);
});

test("all samples can add a missed positive example; clear removes inherited feedback in a full replacement", async () => {
  const job = feedbackJob(); job.feedback = { version: 2, annotations: [{ frame_id: "F0001", label: "dislike", reason: "祖先里的评价" }], note: "" };
  const { nodes, calls, feedbackRecords, ready } = await openFixtureJob(job, { feedback: { ...job.feedback, version: 3 } });
  assert.equal(withClass(nodes["evidence-content"], "frame-feedback").length, 1, "Selected-only is the initial evidence filter");
  frameFeedback(nodes, "F0001").buttons[2].events.click();
  selectAllFrames(nodes);
  assert.equal(withClass(nodes["evidence-content"], "frame-feedback").length, 2);
  frameFeedback(nodes, "F0002").buttons[0].events.click();
  const reason = frameFeedback(nodes, "F0002").reason; reason.value = "漏了这个傻傻的正脸"; reason.events.input();
  await nodes["save-feedback"].events.click(); await ready();
  const puts = feedbackCalls(calls, "PUT"); assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0].options.body), { expected_version: 3, annotations: [{ frame_id: "F0002", label: "like", reason: "漏了这个傻傻的正脸" }], note: "" });
  assert.equal(feedbackRecords.get(job.id).version, 4);
  await nodes["recent-jobs"].children[0].events.click(); await ready();
  assert.equal(frameFeedback(nodes, "F0001").controls.dataset.label, "neutral", "Cleared ancestor votes must not reappear");
  assert.equal(frameFeedback(nodes, "F0002").controls.dataset.label, "like");
  assert.equal(reviseCalls(calls).length, 0, "Saving must never call AI");
});

test("revision saves dirty feedback first, snapshots edited duration/Prompt and prevents duplicate submissions or reupload", async () => {
  const job = feedbackJob();
  const child = feedbackJob("feedback-child", { status: "queued", progress: 0, iteration: { root_job_id: job.id, parent_job_id: job.id, round: 4, reused_sampling: true } });
  const { nodes, calls, ready } = await openFixtureJob(job, { postJob: child });
  editNote(nodes, "多留全脸");
  nodes["target-duration"].value = "45"; nodes["target-duration"].events.input();
  nodes["min-duration"].value = "35"; nodes["max-duration"].value = "55";
  nodes["prompt-template"].value = "EDITED REVISION PROMPT"; nodes["prompt-template"].events.input();
  nodes["sample-interval"].value = "3"; // Even an attempted DOM change cannot alter reused sampling.
  const first = nodes["revise-feedback"].events.click();
  const duplicate = nodes["revise-feedback"].events.click();
  await Promise.all([first, duplicate]); await ready();
  const puts = feedbackCalls(calls, "PUT"); const posts = reviseCalls(calls);
  assert.equal(puts.length, 1); assert.equal(posts.length, 1);
  assert.ok(calls.indexOf(puts[0]) < calls.indexOf(posts[0]));
  const body = JSON.parse(posts[0].options.body);
  assert.equal(body.expected_version, 1);
  assert.match(body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(body.options, { target_duration: 45, min_duration: 35, max_duration: 55, sample_interval: 1, prompt: "EDITED REVISION PROMPT" });
  assert.equal(calls.filter((call) => call.url === "/api/jobs" && call.options.method === "POST").length, 0, "Revision reuses the original upload");
  assert.match(allText(nodes["iterations-panel"]), /V4/);
  assert.equal(nodes["revise-feedback"].textContent, "应用反馈，生成下一版 ↗", "Do not guess the next family version when branching");
});

test("unknown revision response freezes UUID and complete body, never auto-retries, and can confirm after config becomes unavailable", async () => {
  const job = feedbackJob(); const config = configFixture();
  const child = feedbackJob("confirmed-child", { status: "queued", progress: 0, iteration: { root_job_id: job.id, parent_job_id: job.id, round: 2, reused_sampling: true } });
  let attempts = 0;
  const { nodes, calls, ready } = await openFixtureJob(job, { config, postJob: child, route: (url, options) => {
    if (url.endsWith("/revise") && options.method === "POST") { attempts++; if (attempts === 1) throw new TypeError("connection lost"); return { status: 202, body: child }; }
  } });
  editNote(nodes, "我的固定反馈");
  await nodes["revise-feedback"].events.click(); await ready();
  assert.equal(reviseCalls(calls).length, 1);
  assert.match(nodes["feedback-message"].textContent, /不会自动重试/);
  for (const id of ["feedback-note", "target-duration", "target-slider", "min-duration", "max-duration", "prompt-template", "sample-interval", "generate-button"]) assert.equal(nodes[id].disabled, true, `${id} must remain frozen`);
  assert.equal(nodes["revise-feedback"].disabled, false, "Only explicit same-request confirmation is available");
  assert.equal(nodes["revise-feedback"].textContent, "手动重试同一次提交 ↗");
  const originalBody = reviseCalls(calls)[0].options.body;
  config.configured = false; // A created child can still be confirmed without starting new inference.
  nodes["target-duration"].value = "46"; nodes["prompt-template"].value = "NOT THE FROZEN PROMPT";
  await ready(); assert.equal(reviseCalls(calls).length, 1);
  await nodes["revise-feedback"].events.click(); await ready();
  assert.equal(reviseCalls(calls).length, 2);
  assert.equal(reviseCalls(calls)[1].options.body, originalBody, "Manual retry must reuse UUID and byte-identical complete options");
  assert.equal(feedbackCalls(calls, "PUT").length, 1, "A frozen retry cannot resave a different feedback version");
  assert.equal(nodes["workspace-title"].textContent, child.filename);
});

test("feedback 409 preserves the local draft; explicit server inspection still requires a deliberate resolution", async () => {
  const job = feedbackJob(); let gets = 0; let puts = 0;
  const remote = { version: 4, annotations: [{ frame_id: "F0001", label: "dislike", reason: "另一页的评价" }], note: "另一页的备注" };
  const { nodes, calls, ready } = await openFixtureJob(job, { feedback: { version: 3, annotations: [], note: "" }, route: (url, options) => {
    if (url !== `/api/jobs/${job.id}/feedback`) return;
    if (options.method === "PUT") { puts++; if (puts === 1) return { status: 409, body: { detail: "stale version" } }; const body = JSON.parse(options.body); return { body: { version: 5, annotations: body.annotations, note: body.note } }; }
    gets++; if (gets > 1) return { body: remote };
  } });
  selectAllFrames(nodes); frameFeedback(nodes, "F0002").buttons[0].events.click(); editNote(nodes, "我的未保存备注");
  await nodes["save-feedback"].events.click(); await ready();
  assert.equal(nodes["feedback-note"].value, "我的未保存备注");
  assert.equal(nodes["revise-feedback"].disabled, true);
  assert.equal(feedbackCalls(calls).length, 1, "409 must not trigger an automatic feedback refetch");
  let conflict = nodes["feedback-conflict"];
  await descendants(conflict, (node) => node.tagName === "BUTTON" && node.textContent.startsWith("检查服务器"))[0].events.click(); await ready();
  assert.equal(nodes["feedback-note"].value, "我的未保存备注");
  assert.equal(frameFeedback(nodes, "F0002").controls.dataset.label, "like");
  assert.match(allText(conflict), /另一页的备注/);
  assert.equal(JSON.parse(nodes["feedback-draft-preview"].textContent).expected_version, 3, "Inspecting remote cannot silently adopt its version");
  assert.equal(reviseCalls(calls).length, 0);
  await descendants(conflict, (node) => node.tagName === "BUTTON" && node.textContent.startsWith("确认用我的完整草稿"))[0].events.click(); await ready();
  const payload = JSON.parse(feedbackCalls(calls, "PUT")[1].options.body);
  assert.equal(payload.expected_version, 4);
  assert.deepEqual(payload.annotations, [{ frame_id: "F0002", label: "like", reason: "" }]);
  assert.equal(payload.note, "我的未保存备注");
  assert.equal(nodes["feedback-conflict"].hidden, true);
  assert.equal(nodes["feedback-note"].value, "我的未保存备注");
});

test("sheet hit-testing opens the exact frame without casting a vote, including no-op gutters", async () => {
  const { nodes, calls } = await openFixtureJob(feedbackJob());
  withClass(nodes["evidence-content"], "sheet-image-button")[0].events.click();
  nodes["dialog-image"].testRect = { left: 10, top: 20, width: 240, height: 200 };
  nodes["dialog-image"].events.click({ clientX: 125, clientY: 45 }); // x=115: gutter between the two actual frame boxes.
  assert.equal(nodes["frame-dialog"].open, undefined);
  assert.equal(JSON.parse(nodes["feedback-draft-preview"].textContent).annotations.length, 0);
  nodes["dialog-image"].events.click({ clientX: 135, clientY: 45 }); // x=125,y=25: F0002.
  assert.equal(nodes["frame-dialog"].open, true);
  assert.match(nodes["frame-dialog-title"].textContent, /^F0002/);
  assert.match(nodes["frame-dialog-image"].src, /f2\.jpg$/);
  assert.equal(JSON.parse(nodes["feedback-draft-preview"].textContent).annotations.length, 0, "Opening an inspector is not feedback");
  const inspector = frameFeedback(nodes, "F0002", nodes["frame-dialog-controls"]);
  inspector.buttons[0].events.click(); inspector.reason.value = "这个好可爱"; inspector.reason.events.input();
  nodes["close-frame-dialog"].events.click(); selectAllFrames(nodes);
  assert.equal(frameFeedback(nodes, "F0002").controls.dataset.label, "like");
  assert.equal(frameFeedback(nodes, "F0002").reason.value, "这个好可爱");
  assert.equal(feedbackCalls(calls, "PUT").length, 0); assert.equal(reviseCalls(calls).length, 0);
});

test("failed real rounds retain inspectable proposals/comparison and feedback; virtual legacy previews cannot revise", async () => {
  const job = feedbackJob("failed-round", { status: "failed", result: { selected_frames: [] },
    ai: { call_count: 1, raw_response: "MODEL RAW PROPOSAL", parsed: { selected_frames: [{ frame_id: "F0002", score: 98, reason: "原始提议" }] } },
    feedback: { version: 7, annotations: [{ frame_id: "F0002", label: "dislike", reason: "之前说不要" }], note: "冻结备注" },
    comparison: { parent_job_id: "parent", added_frame_ids: ["F0002"], removed_frame_ids: ["F0001"], kept_frame_ids: [], liked_omitted_ids: [], disliked_selected_ids: ["F0002"] }
  });
  job.sampling.frames.forEach((frame) => { frame.selected = false; });
  const { nodes, calls, ready } = await openFixtureJob(job, { legacy: legacyFixture() });
  assert.equal(nodes["feedback-panel"].hidden, false);
  assert.equal(nodes["feedback-note"].disabled, false);
  assert.match(allText(nodes["evidence-content"]), /原始提议.*不代表通过校验/);
  assert.ok(frameFeedback(nodes, "F0002"));
  assert.match(allText(nodes["iterations-panel"]), /不想要却仍被选 1/);
  assert.match(allText(nodes["request-content"]), /MODEL RAW PROPOSAL/);
  assert.match(allText(nodes["request-content"]), /冻结备注/);
  assert.match(allText(nodes["evidence-content"]), /尝试不保证送达或已被模型理解/);
  assert.match(html, /“不想要”仅排除可爱证据帧，不等于精确裁掉前后整段/);
  nodes["legacy-shortcut"].events.click(); await ready();
  assert.equal(nodes["feedback-panel"].hidden, true);
  assert.equal(nodes["iterations-panel"].hidden, true);
  assert.match(nodes["notice-banner"].textContent, /本版不支持反馈重选/);
  await nodes["revise-feedback"].events.click();
  assert.equal(reviseCalls(calls).length, 0);
});

test("a live failure refreshes evidence with raw proposals even when sample sheets and attempt count are unchanged", async () => {
  const job = feedbackJob("live-failure", { status: "analyzing", result: { selected_frames: [] } });
  job.sampling.frames.forEach((frame) => { frame.selected = false; });
  const run = await openFixtureJob(job, { route: (url) => url === `/api/jobs/${job.id}` ? { body: structuredClone(job) } : undefined });
  assert.equal(withClass(run.nodes["evidence-content"], "frame-feedback").length, 0);
  job.status = "failed"; job.ai.parsed = { selected_frames: [{ frame_id: "F0002", score: 95, reason: "失败前的原始提议" }] };
  await run.poll(); await run.ready();
  assert.match(allText(run.nodes["evidence-content"]), /原始提议.*不代表通过校验/);
  assert.ok(frameFeedback(run.nodes, "F0002"));
  assert.equal(frameFeedback(run.nodes, "F0002").reason.maxLength, 500);
  assert.equal(run.nodes["feedback-note"].disabled, false);
  assert.equal(feedbackCalls(run.calls, "GET", job.id).length, 1);
  assert.match(html, /id="feedback-note"[^>]*maxlength="4000"/);
});

function standardFixture({ two = false } = {}) {
  const versions = [{ id: "P0001", name: "原始通用标准", text: "BASE UNIVERSAL STANDARD", parent_version_id: null, summary: "基础规则", diff: "" }];
  if (two) versions.push({ id: "P0002", name: "已有第二版", text: "SECOND UNIVERSAL STANDARD", parent_version_id: "P0001", summary: "正脸优先", diff: "-BASE\n+SECOND" });
  return { revision: two ? 1 : 0, active_version_id: two ? "P0002" : "P0001", versions, proposals: [] };
}
function standardConfig(library) {
  const config = configFixture(); const active = library.versions.find((version) => version.id === library.active_version_id);
  config.prompt_template = active.text; config.prompt_library = { revision: library.revision, active_version_id: active.id, active: structuredClone(active) }; return config;
}
function proposalFixture(overrides = {}) {
  return { id: "Q0001", status: "completed", base_revision: 0, base_version_id: "P0001", base_prompt: "BASE UNIVERSAL STANDARD",
    sources: [{ job_id: "feedback-test", feedback_version: 1 }], note: "文字调优意见", summary: "偏好露脸，不硬凑时长", candidate_prompt: "CANDIDATE UNIVERSAL STANDARD <script>STAYS TEXT</script>",
    changes: [{ before: "旧规则", after: "新规则", reason: "因为用户明确偏爱全脸", evidence: [{ job_id: "feedback-test", frame_id: "F0002" }] }], warnings: ["未重新看图，不能推断未标记画面"],
    diff: "--- baseline\n+++ candidate\n-BASE UNIVERSAL STANDARD\n+CANDIDATE UNIVERSAL STANDARD", prompt: { system: "TEXT ONLY SYSTEM", user: "SAVED FEEDBACK ONLY" },
    ai: { call_count: 1, text_call_count: 1, visual_call_count: 0, image_count: 0, raw_response: "RAW TEXT RESPONSE", usage: { total_tokens: 123 } }, timings: { total_seconds: 2.75 }, ...overrides };
}
function editStandard(nodes, text, name = "") { nodes["standard-editor"].value = text; nodes["standard-name"].value = name; nodes["standard-editor"].events.input(); }
function confirmPublish(nodes) { nodes["confirm-standard-publish"].checked = true; nodes["confirm-standard-publish"].events.change(); }
function libraryPosts(calls, kind = "versions") { return calls.filter((call) => call.url === `/api/prompt-library/${kind}` && call.options.method === "POST"); }
function proposalPosts(calls) { return calls.filter((call) => call.url === "/api/prompt-proposals" && call.options.method === "POST"); }
function satisfiedPosts(calls) { return calls.filter((call) => call.url === "/api/prompt-proposals/satisfied-round" && call.options.method === "POST"); }
function pickStandard(nodes, id) { descendants(nodes["standard-version-list"], (node) => node.dataset.standardVersionId === id)[0].events.click(); }
function syntheticUpload(nodes, name) { const file = new Blob(["synthetic-test-video"], { type: "video/mp4" }); file.name = name; nodes["video-file"].events.change({ target: { files: [file] } }); }

test("new videos default to the active standard, custom edits affect only one submission, and the next file resets to active", async () => {
  const library = standardFixture(); const config = standardConfig(library);
  const job = timingJob(undefined); job.options.prompt = library.versions[0].text;
  const run = harness({ config, library, job, postJob: job }); const { nodes, calls } = run; await run.ready();
  assert.equal(nodes["prompt-template"].value, "BASE UNIVERSAL STANDARD");
  assert.match(nodes["prompt-mode"].textContent, /本次跟随生效标准 P0001/);
  syntheticUpload(nodes, "first.mp4"); await nodes["generate-form"].events.submit({ preventDefault() {} });
  syntheticUpload(nodes, "second.mp4"); nodes["prompt-template"].value = "ONLY THIS VIDEO"; nodes["prompt-template"].events.input();
  await nodes["generate-form"].events.submit({ preventDefault() {} });
  syntheticUpload(nodes, "third.mp4"); await nodes["generate-form"].events.submit({ preventDefault() {} });
  syntheticUpload(nodes, "blank-falls-back.mp4"); nodes["prompt-template"].value = ""; nodes["prompt-template"].events.input(); await nodes["generate-form"].events.submit({ preventDefault() {} });
  const uploads = calls.filter((call) => call.url === "/api/jobs" && call.options.method === "POST").map((call) => JSON.parse(call.options.body.get("options")));
  assert.equal(uploads.length, 4); assert.equal(uploads[0].use_active_prompt, true); assert.equal(uploads[0].prompt, "BASE UNIVERSAL STANDARD");
  assert.equal(Object.hasOwn(uploads[1], "use_active_prompt"), false); assert.equal(uploads[1].prompt, "ONLY THIS VIDEO");
  assert.equal(uploads[2].use_active_prompt, true); assert.equal(uploads[2].prompt, "BASE UNIVERSAL STANDARD");
  assert.equal(uploads[3].use_active_prompt, true); assert.equal(uploads[3].prompt, "");
  assert.equal(libraryPosts(calls).length, 0); assert.equal(proposalPosts(calls).length, 0);
  assert.equal(run.librarySnapshot().active_version_id, "P0001");
});

test("old tasks retain their actual prompt; only explicit use-active enables global reselection, and selecting a new file cannot revise the old one", async () => {
  const library = standardFixture({ two: true }); const job = feedbackJob(); job.options.prompt = "ACTUAL OLD TASK PROMPT"; job.prompt_standard = { mode: "global", version_id: "P0001", revision: 0 };
  const child = feedbackJob("old-task-child");
  const { nodes, calls, ready } = await openFixtureJob(job, { config: standardConfig(library), library, postJob: child });
  assert.equal(nodes["prompt-template"].value, "ACTUAL OLD TASK PROMPT");
  assert.match(nodes["prompt-mode"].textContent, /本次自定义.*原任务实际使用 P0001/);
  editNote(nodes, "保留旧任务的原规则");
  syntheticUpload(nodes, "new-video.mp4");
  assert.equal(nodes["prompt-template"].value, "SECOND UNIVERSAL STANDARD"); assert.equal(nodes["revise-feedback"].disabled, true);
  await nodes["revise-feedback"].events.click(); assert.equal(reviseCalls(calls).length, 0);
  await nodes["recent-jobs"].children[0].events.click(); await ready();
  assert.equal(nodes["prompt-template"].value, "ACTUAL OLD TASK PROMPT");
  await nodes["revise-feedback"].events.click(); await ready();
  const oldOptions = JSON.parse(reviseCalls(calls)[0].options.body).options;
  assert.equal(oldOptions.prompt, "ACTUAL OLD TASK PROMPT"); assert.equal(Object.hasOwn(oldOptions, "use_active_prompt"), false);
  await descendants(nodes["recent-jobs"], (node) => node.tagName === "BUTTON" && allText(node).includes(job.filename))[0].events.click(); await ready();
  nodes["use-active-prompt"].events.click(); await nodes["revise-feedback"].events.click(); await ready();
  const newOptions = JSON.parse(reviseCalls(calls)[1].options.body).options;
  assert.equal(newOptions.use_active_prompt, true); assert.equal(newOptions.prompt, "SECOND UNIVERSAL STANDARD");
  assert.equal(job.options.prompt, "ACTUAL OLD TASK PROMPT", "Historical fixture must not be mutated");
});

test("manual standard edits require a checked full-text confirmation; publish and historical rollback are explicit zero-AI operations", async () => {
  const library = standardFixture(); const run = harness({ config: standardConfig(library), library }); const { nodes, calls } = run; await run.ready();
  editStandard(nodes, "MY NEW STANDARD", "正脸小表情");
  assert.equal(run.librarySnapshot().active_version_id, "P0001");
  assert.equal(nodes["publish-standard"].disabled, true); await nodes["publish-standard"].events.click(); assert.equal(libraryPosts(calls).length, 0);
  confirmPublish(nodes); const first = nodes["publish-standard"].events.click(); const duplicate = nodes["publish-standard"].events.click(); await Promise.all([first, duplicate]); await run.ready();
  assert.equal(libraryPosts(calls).length, 1); const body = JSON.parse(libraryPosts(calls)[0].options.body);
  assert.equal(body.expected_revision, 0); assert.equal(body.text, "MY NEW STANDARD"); assert.equal(body.name, "正脸小表情"); assert.match(body.request_id, /^[0-9a-f-]{36}$/i);
  assert.match(nodes["prompt-active-badge"].textContent, /P0002/); assert.equal(nodes["active-standard-text"].textContent, "MY NEW STANDARD");
  assert.equal(run.librarySnapshot().versions[0].text, "BASE UNIVERSAL STANDARD"); assert.equal(run.librarySnapshot().versions.length, 2);
  pickStandard(nodes, "P0001"); assert.equal(run.librarySnapshot().active_version_id, "P0002", "Selecting a row cannot activate it");
  await nodes["activate-standard"].events.click(); await run.ready();
  assert.equal(libraryPosts(calls, "activate").length, 1); assert.equal(run.librarySnapshot().active_version_id, "P0001"); assert.equal(run.librarySnapshot().versions.length, 2);
  assert.equal(proposalPosts(calls).length, 0); assert.equal(reviseCalls(calls).length, 0);
});

test("feedback-to-prompt first saves dirty feedback, makes one text-only proposal, and never activates a candidate without explicit adoption and publication", async () => {
  const library = standardFixture(); const job = feedbackJob(); const proposal = proposalFixture();
  const run = await openFixtureJob(job, { config: standardConfig(library), library, postProposal: proposal }); const { nodes, calls } = run;
  editNote(nodes, "偏爱露脸，少留长段低头");
  await nodes["feedback-to-prompt"].events.click(); assert.equal(nodes["prompt-library-panel"].open, true);
  assert.equal(proposalPosts(calls).length, 0, "The source-selection shortcut does not invoke AI");
  nodes["proposal-note"].value = "不要把本视频帧号写成通用规则";
  const first = nodes["generate-prompt-proposal"].events.click(); const duplicate = nodes["generate-prompt-proposal"].events.click(); await Promise.all([first, duplicate]); await run.ready();
  assert.equal(feedbackCalls(calls, "PUT").length, 1); assert.equal(proposalPosts(calls).length, 1);
  assert.ok(calls.indexOf(feedbackCalls(calls, "PUT")[0]) < calls.indexOf(proposalPosts(calls)[0]));
  const body = JSON.parse(proposalPosts(calls)[0].options.body); assert.deepEqual(body.sources, [{ job_id: job.id, feedback_version: 1 }]); assert.equal(body.expected_revision, 0); assert.equal(body.note, "不要把本视频帧号写成通用规则");
  assert.equal(Object.hasOwn(body, "images"), false); assert.equal(run.librarySnapshot().active_version_id, "P0001");
  assert.equal(nodes["standard-editor"].value, "BASE UNIVERSAL STANDARD"); assert.equal(nodes["prompt-template"].value, "BASE PROMPT", "Candidate must not replace the current video's actual template");
  assert.match(allText(nodes["proposal-content"]), /图片请求 0/); assert.ok(allText(nodes["proposal-content"]).includes(proposal.diff)); assert.ok(allText(nodes["proposal-content"]).includes("<script>STAYS TEXT</script>")); assert.match(allText(nodes["proposal-content"]), /RAW TEXT RESPONSE/);
  descendants(nodes["proposal-content"], (node) => node.dataset.adoptCandidate === "true")[0].events.click();
  assert.equal(nodes["standard-editor"].value, proposal.candidate_prompt); assert.equal(nodes["publish-standard"].disabled, true); assert.equal(run.librarySnapshot().active_version_id, "P0001");
  confirmPublish(nodes); await nodes["publish-standard"].events.click(); await run.ready();
  assert.equal(JSON.parse(libraryPosts(calls)[0].options.body).proposal_id, proposal.id); assert.equal(run.librarySnapshot().active_version_id, "P0002");
  assert.equal(nodes["prompt-template"].value, "BASE PROMPT", "Publishing cannot silently alter an old task's per-video text");
  assert.equal(reviseCalls(calls).length, 0);
});

test("multiple saved-feedback sources retain exact versions and proposal polling uses only read requests", async () => {
  const library = standardFixture(); const first = feedbackJob("source-one"); const second = feedbackJob("source-two");
  const run = await openFixtureJob(first, { config: standardConfig(library), library, jobs: [first, second], feedbackByJob: { [first.id]: { version: 3, annotations: [], note: "已保存第一段" }, [second.id]: { version: 7, annotations: [{ frame_id: "F0001", label: "like", reason: "正脸" }], note: "已保存第二段" } } });
  const { nodes, calls } = run; await nodes["add-current-prompt-source"].events.click(); nodes["prompt-source-job"].value = second.id; await nodes["add-prompt-source"].events.click();
  assert.equal(withClass(nodes["prompt-source-list"], "prompt-source").length, 2);
  await nodes["generate-prompt-proposal"].events.click(); await run.ready();
  const body = JSON.parse(proposalPosts(calls)[0].options.body); assert.deepEqual(body.sources, [{ job_id: first.id, feedback_version: 3 }, { job_id: second.id, feedback_version: 7 }]);
  run.proposalRecords.set("Q0001", proposalFixture({ sources: body.sources })); await run.pollProposal(); await run.ready();
  assert.equal(proposalPosts(calls).length, 1); assert.equal(calls.filter((call) => call.url === "/api/prompt-proposals/Q0001" && !call.options.method).length, 1);
  assert.match(allText(nodes["proposal-content"]), /候选已完成 · 尚未发布/); assert.equal(run.librarySnapshot().active_version_id, "P0001");
});

for (const kind of ["versions", "activate", "proposal"]) test(`${kind} lost response freezes complete body and UUID until explicit same-request confirmation`, async () => {
  const library = standardFixture({ two: kind === "activate" }); const config = standardConfig(library); const job = feedbackJob(); let attempts = 0;
  const endpoint = kind === "proposal" ? "/api/prompt-proposals" : `/api/prompt-library/${kind}`;
  const responseLibrary = structuredClone(library); responseLibrary.revision++;
  if (kind === "versions") { responseLibrary.versions.push({ id: "P0002", name: "已保存", text: "FROZEN EDITOR TEXT", parent_version_id: "P0001" }); responseLibrary.active_version_id = "P0002"; }
  if (kind === "activate") responseLibrary.active_version_id = "P0001";
  const run = await openFixtureJob(job, { config, library, feedback: { version: 2, annotations: [], note: "已保存的反馈" }, route: (url, options) => {
    if (url === endpoint && options.method === "POST") { attempts++; if (attempts === 1) throw new TypeError("response lost"); return { status: kind === "proposal" ? 202 : 200, body: kind === "proposal" ? proposalFixture({ status: "queued" }) : responseLibrary }; }
  } }); const { nodes, calls } = run;
  let action;
  if (kind === "versions") { editStandard(nodes, "FROZEN EDITOR TEXT"); confirmPublish(nodes); action = nodes["publish-standard"]; }
  else if (kind === "activate") { pickStandard(nodes, "P0001"); action = nodes["activate-standard"]; }
  else { await nodes["add-current-prompt-source"].events.click(); nodes["proposal-note"].value = "FROZEN PROPOSAL NOTE"; action = nodes["generate-prompt-proposal"]; }
  await action.events.click(); await run.ready();
  const posts = () => calls.filter((call) => call.url === endpoint && call.options.method === "POST");
  assert.equal(posts().length, 1); const frozen = posts()[0].options.body;
  assert.equal(nodes["standard-editor"].disabled, true); assert.equal(nodes["proposal-note"].disabled, true); assert.equal(action.disabled, false);
  assert.match(action.textContent, /手动确认同一次/); config.configured = false;
  nodes["standard-editor"].value = "CHANGED DOM ONLY"; nodes["standard-editor"].events.input(); nodes["proposal-note"].value = "CHANGED NOTE DOM ONLY";
  await run.ready(); assert.equal(posts().length, 1, "No automatic retry or timer may repeat the POST");
  await action.events.click(); await run.ready();
  assert.equal(posts().length, 2); assert.equal(posts()[1].options.body, frozen); assert.match(JSON.parse(frozen).request_id, /^[0-9a-f-]{36}$/i);
  assert.equal(feedbackCalls(calls, "PUT").length, 0, "Same-request confirmation cannot rewrite the source feedback");
});

test("publication 409 preserves candidate and editor; refreshing only inspects, explicit rebasing creates a new request", async () => {
  const library = standardFixture(); const proposal = proposalFixture(); const newer = standardFixture({ two: true }); let posts = 0; let refresh = false;
  library.proposals.push({ id: proposal.id, status: "completed" });
  const run = harness({ config: standardConfig(library), library, proposals: [proposal], route: (url, options) => {
    if (url === "/api/prompt-library" && refresh) return { body: structuredClone(newer) };
    if (url === "/api/prompt-library/versions" && options.method === "POST") { posts++; if (posts === 1) { refresh = true; return { status: 409, body: { detail: "标准已有新版本" } }; } const body = JSON.parse(options.body); return { body: { ...newer, revision: 2, active_version_id: "P0003", versions: [...newer.versions, { id: "P0003", text: body.text, name: "明确核对后发布" }] } }; }
  } }); const { nodes, calls } = run; await run.ready();
  await descendants(nodes["proposal-history"], (node) => node.tagName === "BUTTON")[0].events.click(); await run.ready();
  descendants(nodes["proposal-content"], (node) => node.dataset.adoptCandidate === "true")[0].events.click();
  const inspectionsBeforeConflict = calls.filter((call) => call.url === "/api/prompt-library").length;
  editStandard(nodes, "MY PRESERVED EDITOR <script>TEXT</script>"); confirmPublish(nodes); await nodes["publish-standard"].events.click(); await run.ready();
  assert.equal(nodes["standard-editor"].value, "MY PRESERVED EDITOR <script>TEXT</script>"); assert.equal(nodes["prompt-library-conflict"].hidden, false);
  assert.equal(calls.filter((call) => call.url === "/api/prompt-library").length, inspectionsBeforeConflict, "409 cannot silently refetch and overwrite");
  assert.ok(allText(nodes["proposal-content"]).includes(proposal.candidate_prompt));
  await nodes["refresh-prompt-library"].events.click(); await run.ready();
  assert.equal(nodes["standard-editor"].value, "MY PRESERVED EDITOR <script>TEXT</script>"); assert.match(nodes["prompt-active-badge"].textContent, /P0002/);
  assert.equal(nodes["publish-standard"].disabled, true);
  descendants(nodes["prompt-library-conflict"], (node) => node.tagName === "BUTTON" && node.textContent.startsWith("已核对"))[0].events.click();
  assert.equal(nodes["confirm-standard-publish"].checked, false); confirmPublish(nodes); await nodes["publish-standard"].events.click(); await run.ready();
  const first = JSON.parse(libraryPosts(calls)[0].options.body); const second = JSON.parse(libraryPosts(calls)[1].options.body);
  assert.equal(second.expected_revision, 1); assert.notEqual(second.request_id, first.request_id); assert.equal(second.text, "MY PRESERVED EDITOR <script>TEXT</script>");
  assert.equal(first.proposal_id, proposal.id); assert.equal(Object.hasOwn(second, "proposal_id"), false, "Explicit stale-candidate rebasing becomes manual reviewed text, not silent old-baseline publication");
  assert.equal(proposalPosts(calls).length, 0); assert.match(nodes["prompt-active-badge"].textContent, /P0003/);
});

test("a source-feedback 409 can recover without losing the global edit or candidate when the global revision is unchanged", async () => {
  const library = standardFixture(); const proposal = proposalFixture(); library.proposals = [{ id: proposal.id, status: "completed" }];
  const job = feedbackJob(); let submits = 0;
  const run = await openFixtureJob(job, { config: standardConfig(library), library, proposals: [proposal], feedback: { version: 2, annotations: [], note: "保存过的当前反馈" }, route: (url, options) => {
    if (url === "/api/prompt-proposals" && options.method === "POST") { submits++; if (submits === 1) return { status: 409, body: { detail: "来源反馈版本已变化" } }; }
  } }); const { nodes, calls } = run;
  await descendants(nodes["proposal-history"], (node) => node.tagName === "BUTTON")[0].events.click(); await run.ready();
  editStandard(nodes, "MY UNSAVED STANDARD THAT MUST SURVIVE"); await nodes["add-current-prompt-source"].events.click();
  await nodes["generate-prompt-proposal"].events.click(); await run.ready();
  assert.equal(nodes["publish-standard"].disabled, true); assert.equal(proposalPosts(calls).length, 1);
  await nodes["refresh-prompt-library"].events.click(); await run.ready();
  assert.equal(nodes["prompt-library-conflict"].hidden, true, "An inspected unchanged global revision must clear the unrelated global lock");
  assert.equal(nodes["standard-editor"].value, "MY UNSAVED STANDARD THAT MUST SURVIVE"); assert.ok(allText(nodes["proposal-content"]).includes(proposal.candidate_prompt));
  run.feedbackRecords.set(job.id, { version: 3, annotations: [], note: "另一页面新保存的反馈" });
  await nodes["refresh-prompt-sources"].events.click(); await run.ready();
  assert.equal(nodes["feedback-note"].value, "保存过的当前反馈", "Checking source versions cannot silently replace the local feedback");
  assert.equal(nodes["feedback-conflict"].hidden, false);
  descendants(nodes["feedback-conflict"], (node) => node.tagName === "BUTTON" && node.textContent.startsWith("使用服务器版本"))[0].events.click();
  await nodes["generate-prompt-proposal"].events.click(); await run.ready();
  assert.equal(proposalPosts(calls).length, 2); assert.deepEqual(JSON.parse(proposalPosts(calls)[1].options.body).sources, [{ job_id: job.id, feedback_version: 3 }]);
  assert.equal(nodes["standard-editor"].value, "MY UNSAVED STANDARD THAT MUST SURVIVE"); assert.equal(libraryPosts(calls).length, 0);
});

test("a delayed old library GET cannot overwrite a newer successful publication or create a false conflict", async () => {
  const library = standardFixture(); let releaseOldRead; let reads = 0;
  const run = harness({ config: standardConfig(library), library, route: (url) => {
    if (url === "/api/prompt-library" && ++reads === 1) return new Promise((resolve) => { releaseOldRead = () => resolve({ body: structuredClone(library) }); });
  } }); const { nodes } = run; await run.ready();
  assert.equal(typeof releaseOldRead, "function");
  editStandard(nodes, "NEWER PUBLISHED STANDARD"); confirmPublish(nodes); await nodes["publish-standard"].events.click(); await run.ready();
  assert.match(nodes["prompt-active-badge"].textContent, /P0002/);
  releaseOldRead(); await run.ready();
  assert.match(nodes["prompt-active-badge"].textContent, /P0002/); assert.equal(nodes["active-standard-text"].textContent, "NEWER PUBLISHED STANDARD");
  assert.equal(nodes["standard-editor"].value, "NEWER PUBLISHED STANDARD"); assert.equal(nodes["prompt-library-conflict"].hidden, true);
  assert.equal(descendants(nodes["standard-version-list"], (node) => node.dataset.standardVersionId).length, 2);
  assert.match(nodes["prompt-library-message"].textContent, /旧快照已忽略/);
});

test("config refresh appends a newly active version without losing history or overwriting an old task's actual template", async () => {
  const library = standardFixture({ two: true }); const newest = { id: "P0003", name: "另一页发布", text: "NEWEST ACTIVE THIRD STANDARD", parent_version_id: "P0002" };
  const newerConfig = standardConfig({ ...library, revision: 2, active_version_id: newest.id, versions: [...library.versions, newest] });
  const job = feedbackJob(); job.options.prompt = "ACTUAL HISTORICAL PROMPT";
  const run = await openFixtureJob(job, { config: standardConfig(library), library, route: (url, options) => url === "/api/config" && options.method === "PUT" ? { body: newerConfig } : undefined });
  await run.nodes["save-config"].events.click(); await run.ready();
  assert.equal(descendants(run.nodes["standard-version-list"], (node) => node.dataset.standardVersionId).length, 3);
  assert.match(run.nodes["prompt-active-badge"].textContent, /P0003/); assert.equal(run.nodes["active-standard-text"].textContent, newest.text);
  assert.equal(run.nodes["prompt-template"].value, "ACTUAL HISTORICAL PROMPT"); assert.match(run.nodes["prompt-mode"].textContent, /本次自定义/);
});

test("source selection caps at twelve and does not silently discard a standard edit", async () => {
  const library = standardFixture(); const jobs = Array.from({ length: 13 }, (_, index) => feedbackJob(`source-${index + 1}`));
  const feedbackByJob = Object.fromEntries(jobs.map((job, index) => [job.id, { version: index + 1, annotations: [], note: `保存反馈 ${index + 1}` }]));
  const run = harness({ config: standardConfig(library), library, jobs, job: jobs[0], feedbackByJob }); await run.ready();
  editStandard(run.nodes, "KEEP THIS DRAFT");
  for (const job of jobs) { run.nodes["prompt-source-job"].value = job.id; await run.nodes["add-prompt-source"].events.click(); }
  assert.equal(withClass(run.nodes["prompt-source-list"], "prompt-source").length, 12); assert.match(run.nodes["proposal-message"].textContent, /最多选择 12/);
  assert.equal(feedbackCalls(run.calls, "GET", jobs[12].id).length, 0); assert.equal(run.nodes["standard-editor"].value, "KEEP THIS DRAFT");
  assert.equal(proposalPosts(run.calls).length, 0);
});

test("publishing a new standard and polling a running old task never replace its frozen actual prompt or provenance", async () => {
  const library = standardFixture({ two: true }); const job = feedbackJob("running-historical", { status: "analyzing", prompt_standard: { mode: "global", version_id: "P0001", revision: 0 } }); job.options.prompt = "FROZEN HISTORICAL ACTUAL TEXT";
  const run = await openFixtureJob(job, { config: standardConfig(library), library, route: (url) => url === `/api/jobs/${job.id}` ? { body: structuredClone(job) } : undefined });
  editStandard(run.nodes, "LATEST THIRD GLOBAL STANDARD"); confirmPublish(run.nodes); await run.nodes["publish-standard"].events.click(); await run.ready();
  assert.match(run.nodes["prompt-active-badge"].textContent, /P0003/); assert.equal(run.nodes["prompt-template"].value, "FROZEN HISTORICAL ACTUAL TEXT");
  await run.poll(); assert.equal(run.nodes["prompt-template"].value, "FROZEN HISTORICAL ACTUAL TEXT"); assert.match(run.nodes["prompt-mode"].textContent, /本次自定义.*原任务实际使用 P0001/);
  job.status = "completed"; await run.poll(); await run.ready();
  assert.equal(run.nodes["prompt-template"].value, "FROZEN HISTORICAL ACTUAL TEXT"); assert.match(allText(run.nodes["request-content"]), /P0001/);
  assert.equal(run.calls.filter((call) => call.url === "/api/jobs" && call.options.method === "POST").length, 0); assert.equal(proposalPosts(run.calls).length, 0);
});

function satisfiedFixture(overrides = {}) {
  return proposalFixture({ source_mode: "satisfied_round", tuning_base_prompt: "ACTUAL SATISFIED ROUND TEMPLATE",
    satisfied_round: { job_id: "satisfied-two", round: 2, prompt_sha256: "test-frozen-template-hash", feedback_version: 4, annotation_count: 2, has_applied_feedback: true },
    ai: { call_count: 1, text_call_count: 0, visual_call_count: 1, image_count: 3, raw_response: "TEST-ONLY VISUAL TUNING RESPONSE" }, ...overrides });
}
function satisfiedJob(id = "satisfied-two", overrides = {}) {
  return feedbackJob(id, { iteration: { root_job_id: "satisfied-root", parent_job_id: "satisfied-root", round: 2 },
    feedback: { version: 4, annotations: [{ frame_id: "F0001", label: "like", reason: "正脸" }, { frame_id: "F0002", label: "dislike", reason: "长时间背头" }], note: "冻结的本轮反馈" }, ...overrides });
}
async function prepareSatisfied(run) { await run.nodes["prepare-satisfied-standard"].events.click(); }
function reviewCandidate(nodes) { nodes["confirm-prompt-candidate"].checked = true; nodes["confirm-prompt-candidate"].events.change(); }

test("satisfied-round entry binds the displayed historical successful round, never its newer family round or editable drafts", async () => {
  const library = standardFixture(); const job = satisfiedJob(); const newer = satisfiedJob("satisfied-three", { iteration: { root_job_id: "satisfied-root", round: 3 } });
  const proposal = satisfiedFixture();
  const run = await openFixtureJob(job, { config: standardConfig(library), library, jobs: [job, newer], versions: [{ id: job.id, round: 2, status: "completed" }, { id: newer.id, round: 3, status: "completed" }], postProposal: proposal });
  const { nodes, calls } = run;
  assert.equal(nodes["satisfied-standard-entry"].hidden, false);
  assert.match(nodes["satisfied-entry-source"].textContent, /历史.*第 2 轮/);
  editNote(nodes, "还没保存，不属于这个成功结果"); editStandard(nodes, "MY SEPARATE DIRTY STANDARD");
  nodes["prompt-template"].value = "UNSAVED PER-VIDEO TEMPLATE"; nodes["prompt-template"].events.input();
  await prepareSatisfied(run);
  assert.equal(satisfiedPosts(calls).length, 0, "Choosing a satisfactory round alone cannot invoke AI");
  assert.equal(nodes["satisfied-round-review"].hidden, false);
  assert.match(nodes["satisfied-round-source"].textContent, /第 2 轮.*satisfied-two/);
  assert.match(nodes["satisfied-round-disclosure"].textContent, /额外.*1 次看图 AI/);
  await nodes["create-satisfied-proposal"].events.click(); await run.ready();
  const body = JSON.parse(satisfiedPosts(calls)[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ["expected_revision", "job_id", "request_id"]);
  assert.equal(body.job_id, job.id); assert.equal(body.expected_revision, 0);
  assert.equal(feedbackCalls(calls, "PUT", job.id).length, 0, "This flow must not save next-round draft feedback");
  assert.equal(nodes["feedback-note"].value, "还没保存，不属于这个成功结果");
  assert.equal(nodes["standard-editor"].value, "MY SEPARATE DIRTY STANDARD");
  assert.ok(allText(nodes["proposal-content"]).includes(proposal.candidate_prompt));
  assert.ok(allText(nodes["proposal-content"]).includes(proposal.diff));
  assert.match(allText(nodes["proposal-content"]), /看图请求 1.*图片 3/);
  assert.match(allText(nodes["proposal-content"]), /test-frozen-template-hash/);
  assert.match(allText(nodes["proposal-content"]), /ACTUAL SATISFIED ROUND TEMPLATE/);
  assert.equal(libraryPosts(calls).length, 0); assert.equal(reviseCalls(calls).length, 0);
  assert.equal(calls.filter((call) => call.url === "/api/jobs" && call.options.method === "POST").length, 0);
});

test("satisfied candidate requires separate review and publishes without overwriting a dirty manual draft or old task options", async () => {
  const library = standardFixture(); const job = satisfiedJob(); const proposal = satisfiedFixture();
  const run = await openFixtureJob(job, { config: standardConfig(library), library, postProposal: proposal }); const { nodes, calls } = run;
  editStandard(nodes, "PRESERVE THIS MANUAL DRAFT", "独立草稿"); await prepareSatisfied(run); await nodes["create-satisfied-proposal"].events.click();
  assert.equal(nodes["publish-prompt-candidate"].disabled, true); await nodes["publish-prompt-candidate"].events.click(); assert.equal(libraryPosts(calls).length, 0);
  reviewCandidate(nodes); assert.equal(nodes["publish-prompt-candidate"].disabled, false);
  await nodes["publish-prompt-candidate"].events.click();
  assert.equal(libraryPosts(calls).length, 1); const body = JSON.parse(libraryPosts(calls)[0].options.body);
  assert.equal(body.text, proposal.candidate_prompt); assert.equal(body.proposal_id, proposal.id); assert.equal(body.expected_revision, 0);
  assert.equal(nodes["standard-editor"].value, "PRESERVE THIS MANUAL DRAFT"); assert.equal(nodes["standard-name"].value, "独立草稿");
  assert.equal(nodes["prompt-template"].value, job.options.prompt); assert.equal(job.options.prompt, "BASE PROMPT");
  assert.equal(run.librarySnapshot().active_version_id, "P0002"); assert.equal(satisfiedPosts(calls).length, 1);
  syntheticUpload(nodes, "next-video.mp4"); assert.equal(nodes["prompt-template"].value, proposal.candidate_prompt);
});

test("satisfied-round uncertain response preserves exact source/body/UUID across navigation and only manually confirms the same request", async () => {
  const library = standardFixture(); const job = satisfiedJob(); const other = feedbackJob("other-video"); let attempts = 0;
  const run = await openFixtureJob(job, { config: standardConfig(library), library, jobs: [job, other], route: (url, options) => {
    if (url === "/api/prompt-proposals/satisfied-round" && options.method === "POST") { attempts++; if (attempts === 1) throw new TypeError("response lost"); return { status: 202, body: satisfiedFixture({ status: "queued" }) }; }
  } }); const { nodes, calls } = run;
  await prepareSatisfied(run); await nodes["create-satisfied-proposal"].events.click();
  assert.equal(satisfiedPosts(calls).length, 1); assert.match(nodes["proposal-message"].textContent, /不会自动重试/);
  assert.equal(nodes["standard-editor"].disabled, true); assert.equal(nodes["generate-prompt-proposal"].disabled, true);
  await nodes["generate-prompt-proposal"].events.click(); assert.equal(proposalPosts(calls).length, 0, "Generic text entry cannot replay another request kind");
  await nodes["recent-jobs"].children[1].events.click(); await run.ready();
  assert.match(nodes["satisfied-round-source"].textContent, /satisfied-two/);
  assert.equal(nodes["prepare-satisfied-standard"].disabled, true);
  assert.equal(nodes["create-satisfied-proposal"].disabled, false);
  await nodes["create-satisfied-proposal"].events.click();
  assert.equal(satisfiedPosts(calls).length, 2); assert.equal(satisfiedPosts(calls)[0].options.body, satisfiedPosts(calls)[1].options.body);
  assert.equal(JSON.parse(satisfiedPosts(calls)[1].options.body).job_id, job.id);
  run.proposalRecords.set("Q0001", satisfiedFixture()); await run.pollProposal(); await run.ready();
  assert.equal(satisfiedPosts(calls).length, 2, "Polling never submits another inference");
});

test("direct candidate publication cannot silently rebase after a CAS conflict or overwrite independent drafts", async () => {
  const library = standardFixture(); const newer = standardFixture({ two: true }); let conflict = false;
  const run = await openFixtureJob(satisfiedJob(), { config: standardConfig(library), library, postProposal: satisfiedFixture(), route: (url, options) => {
    if (url === "/api/prompt-library/versions" && options.method === "POST") { conflict = true; return { status: 409, body: { detail: "已被其他页面发布" } }; }
    if (url === "/api/prompt-library" && conflict) return { body: newer };
  } }); const { nodes, calls } = run; editStandard(nodes, "KEEP MANUAL CONTENT"); await prepareSatisfied(run); await nodes["create-satisfied-proposal"].events.click();
  reviewCandidate(nodes); const before = calls.filter((call) => call.url === "/api/prompt-library").length;
  await nodes["publish-prompt-candidate"].events.click();
  assert.equal(calls.filter((call) => call.url === "/api/prompt-library").length, before, "A conflict must not implicitly refresh or rebase");
  assert.equal(nodes["publish-prompt-candidate"].disabled, true); assert.equal(nodes["standard-editor"].value, "KEEP MANUAL CONTENT");
  await nodes["refresh-prompt-library"].events.click(); await run.ready();
  assert.equal(nodes["publish-prompt-candidate"].disabled, true, "Old candidate remains tied to its real comparison baseline");
  await nodes["publish-prompt-candidate"].events.click(); assert.equal(libraryPosts(calls).length, 1);
  assert.match(allText(nodes["proposal-content"]), /基线.*变化/);
});

test("candidate publication lost response retains the same reviewed candidate even when DOM is edited", async () => {
  const library = standardFixture(); const proposal = satisfiedFixture(); let attempts = 0; const published = structuredClone(library);
  published.revision = 1; published.active_version_id = "P0002"; published.versions.push({ id: "P0002", text: proposal.candidate_prompt, name: "满意轮次通用", source_proposal_id: proposal.id });
  const run = await openFixtureJob(satisfiedJob(), { config: standardConfig(library), library, postProposal: proposal, route: (url, options) => {
    if (url === "/api/prompt-library/versions" && options.method === "POST") { attempts++; if (attempts === 1) throw new TypeError("lost publish response"); return { body: published }; }
  } }); const { nodes, calls } = run; editStandard(nodes, "PRESERVE DIRTY DRAFT"); await prepareSatisfied(run); await nodes["create-satisfied-proposal"].events.click(); reviewCandidate(nodes);
  await nodes["publish-prompt-candidate"].events.click(); assert.equal(nodes["publish-prompt-candidate"].disabled, false);
  assert.match(nodes["publish-prompt-candidate"].textContent, /同一次/); nodes["standard-editor"].value = "DOM ONLY EDIT"; nodes["standard-editor"].events.input();
  await nodes["publish-prompt-candidate"].events.click();
  assert.equal(libraryPosts(calls).length, 2); assert.equal(libraryPosts(calls)[0].options.body, libraryPosts(calls)[1].options.body);
  assert.equal(nodes["standard-editor"].value, "PRESERVE DIRTY DRAFT"); assert.equal(satisfiedPosts(calls).length, 1);
});

for (const status of ["failed", "analyzing", "queued"]) test(`satisfied-round conversion is unavailable for ${status} results`, async () => {
  const library = standardFixture(); const run = await openFixtureJob(satisfiedJob("not-successful", { status }), { config: standardConfig(library), library });
  assert.equal(run.nodes["satisfied-standard-entry"].hidden, true);
  await run.nodes["prepare-satisfied-standard"].events.click(); assert.equal(satisfiedPosts(run.calls).length, 0);
});

test("satisfied round without applied feedback still discloses and requests visual tuning, not a hidden zero-AI copy", async () => {
  const library = standardFixture(); const job = satisfiedJob("first-success", { feedback: undefined, iteration: undefined });
  const proposal = satisfiedFixture({ status: "queued", satisfied_round: { job_id: job.id, round: 1, feedback_version: 0, annotation_count: 0, has_applied_feedback: false }, ai: { type: "visual", text_call_count: 0, visual_call_count: 0, image_count: 1 } });
  const run = await openFixtureJob(job, { config: standardConfig(library), library, postProposal: proposal });
  await prepareSatisfied(run); assert.match(run.nodes["satisfied-round-source"].textContent, /已应用反馈 无/);
  assert.match(run.nodes["satisfied-round-disclosure"].textContent, /额外最多 1 次看图 AI/);
  await run.nodes["create-satisfied-proposal"].events.click();
  assert.equal(satisfiedPosts(run.calls).length, 1); assert.match(allText(run.nodes["proposal-content"]), /看图请求 0.*图片 1/);
  assert.match(allText(run.nodes["proposal-content"]), /本轮已应用反馈 无/);
  assert.doesNotMatch(allText(run.nodes["proposal-content"]), /本轮已应用反馈 v0/);
  assert.equal(libraryPosts(run.calls).length, 0); assert.equal(proposalPosts(run.calls).length, 0);
  assert.equal(run.nodes["prepare-satisfied-standard"].disabled, true); assert.equal(run.nodes["publish-standard"].disabled, true);
  assert.equal(feedbackCalls(run.calls, "PUT", job.id).length, 0);
});

test("a fresh candidate can publish against current global while a separate dirty editor retains its older baseline", async () => {
  const library = standardFixture(); const newer = standardFixture({ two: true }); let readNew = false;
  const proposal = satisfiedFixture({ base_revision: 1, base_version_id: "P0002", base_prompt: "SECOND UNIVERSAL STANDARD" });
  const run = await openFixtureJob(satisfiedJob(), { config: standardConfig(library), library, postProposal: proposal, route: (url, options) => {
    if (url === "/api/prompt-library" && readNew) return { body: newer };
    if (url === "/api/prompt-library/versions" && options.method === "POST") { const body = JSON.parse(options.body); return { body: { ...newer, revision: 2, active_version_id: "P0003", versions: [...newer.versions, { id: "P0003", text: body.text, source_proposal_id: body.proposal_id }] } }; }
  } }); const { nodes, calls } = run;
  editStandard(nodes, "OLDER MANUAL DRAFT TO PRESERVE"); readNew = true; await nodes["refresh-prompt-library"].events.click();
  assert.equal(nodes["prompt-library-conflict"].hidden, false);
  await prepareSatisfied(run); await nodes["create-satisfied-proposal"].events.click();
  assert.equal(JSON.parse(satisfiedPosts(calls)[0].options.body).expected_revision, 1);
  reviewCandidate(nodes); assert.equal(nodes["publish-prompt-candidate"].disabled, false); await nodes["publish-prompt-candidate"].events.click();
  assert.equal(JSON.parse(libraryPosts(calls)[0].options.body).expected_revision, 1);
  assert.equal(nodes["standard-editor"].value, "OLDER MANUAL DRAFT TO PRESERVE"); assert.match(nodes["prompt-active-badge"].textContent, /P0003/);
});

test("a delayed history read cannot replace a newer satisfied-round request or expose publication of the wrong candidate", async () => {
  const library = standardFixture(); const old = proposalFixture({ id: "old-candidate" }); library.proposals.push({ id: old.id, status: "completed" }); let releaseOld;
  const run = await openFixtureJob(satisfiedJob(), { config: standardConfig(library), library, postProposal: satisfiedFixture(), route: (url) => {
    if (url === "/api/prompt-proposals/old-candidate") return new Promise((resolve) => { releaseOld = () => resolve({ body: old }); });
  } });
  const history = descendants(run.nodes["proposal-history"], (node) => node.tagName === "BUTTON")[0].events.click();
  await prepareSatisfied(run); await run.nodes["create-satisfied-proposal"].events.click();
  releaseOld(); await history; await run.ready();
  assert.match(allText(run.nodes["proposal-content"]), /satisfied-two/); assert.equal(allText(run.nodes["proposal-content"]).includes("old-candidate"), false);
  assert.equal(satisfiedPosts(run.calls).length, 1); assert.equal(libraryPosts(run.calls).length, 0);
});

test("missing connection never silently invokes satisfactory-round AI, but an already uncertain request can still be confirmed", async () => {
  const library = standardFixture(); const config = standardConfig(library); config.configured = false;
  const run = await openFixtureJob(satisfiedJob(), { config, library, postProposal: satisfiedFixture() });
  await prepareSatisfied(run); await run.nodes["create-satisfied-proposal"].events.click();
  assert.equal(satisfiedPosts(run.calls).length, 0); assert.match(run.nodes["proposal-message"].textContent, /先配置.*最多 1 次看图 AI/);
});

test("satisfactory-round lost-response confirmation bypasses later credential removal without changing its frozen request", async () => {
  const library = standardFixture(); const config = standardConfig(library); let attempts = 0;
  const run = await openFixtureJob(satisfiedJob(), { config, library, route: (url, options) => {
    if (url === "/api/prompt-proposals/satisfied-round" && options.method === "POST") { attempts++; if (attempts === 1) throw new TypeError("lost"); return { status: 202, body: satisfiedFixture({ status: "queued" }) }; }
  } });
  await prepareSatisfied(run); await run.nodes["create-satisfied-proposal"].events.click(); config.configured = false;
  await run.nodes["create-satisfied-proposal"].events.click();
  assert.equal(satisfiedPosts(run.calls).length, 2); assert.equal(satisfiedPosts(run.calls)[0].options.body, satisfiedPosts(run.calls)[1].options.body);
});

function recoveredFixture(overrides = {}) {
  const job = feedbackJob("recovered-test");
  job.prompt = { system: "HISTORICAL SYSTEM PROMPT", user: "HISTORICAL USER PROMPT" };
  job.recovery = { source_job_id: "1cdecaf87df2", source_failed_stage: "render_highlight", source_ai_call_count: 1, source_response_sha256: "a".repeat(64), source_ai_usage: { total_tokens: 8765 }, no_ai_calls: true };
  job.ai = { model: "historical-model", provider: "historical-provider", api_style: "responses", call_count: 0, reused_response_from_job: job.recovery.source_job_id, raw_response: "HISTORICAL RAW RESPONSE", parsed: { summary: "已保存的选择" }, request_manifest: { model: "historical-model", sheet_count: 1, request_type: "HISTORICAL REQUEST" } };
  job.result = { ...job.result, video_url: "/api/jobs/recovered-test/files/highlight.mp4", video_duration: 40, validation: { visual_api_call_count: 0, sheets_sent_in_one_request: 0, source_sheet_count: 1 } };
  return { ...job, ...overrides };
}

test("recovered outputs prominently show original-task provenance and zero current AI/image requests, with historical debug labels", async () => {
  const job = recoveredFixture(); const { nodes, calls } = await openFixtureJob(job);
  assert.match(nodes["workspace-description"].textContent, /复用已有 AI 结果，本次未调用 AI/);
  assert.match(nodes["notice-banner"].textContent, /复用已有 AI 结果，本次未调用 AI/);
  assert.ok(nodes["notice-banner"].textContent.includes(job.recovery.source_job_id));
  assert.match(allText(nodes["highlight-content"]), /本次 0 次 AI 视觉调用/);
  const evidence = allText(nodes["evidence-content"]);
  assert.match(evidence, /本次发送 0 张拼图/); assert.ok(evidence.includes(job.recovery.source_job_id));
  assert.doesNotMatch(evidence, /全部拼图用于同一个请求|本轮请求使用的原始拼图/);
  const request = allText(nodes["request-content"]);
  assert.match(request, /本次视觉请求.*0 次/); assert.match(request, /来源任务 AI 请求.*1 次.*历史/);
  assert.match(request, /原任务历史 · System Prompt/); assert.match(request, /原任务历史 · User Prompt/);
  assert.match(request, /原任务历史请求清单/); assert.match(request, /本次未发送/);
  assert.match(request, /来源任务 AI 用量.*历史/); assert.ok(request.includes('"total_tokens": 8765'));
  assert.ok(request.includes(job.recovery.source_response_sha256)); assert.ok(request.includes("HISTORICAL RAW RESPONSE"));
  assert.doesNotMatch(request, /实际发送 · (?:System|User) Prompt|AI 调用用时|AI 调用（旧记录）/);
  const rawToggle = descendants(nodes["evidence-content"], (node) => node.tagName === "BUTTON" && node.textContent === "来源原图")[0];
  assert.ok(rawToggle); rawToggle.events.click(); withClass(nodes["evidence-content"], "sheet-image-button")[0].events.click();
  assert.match(nodes["image-dialog-description"].textContent, /历史原始拼图/); assert.match(nodes["image-dialog-description"].textContent, /本次未发送/);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 0, "Opening recovery is read-only, not a new AI or recovery request");
});

test("recovery failure keeps its real failure notice while adding provenance rather than replacing the error with success", async () => {
  const job = recoveredFixture({ status: "failed", error: "SYNTHETIC LOCAL RENDER ERROR", result: { selected_frames: [], clips: [], validation: { visual_api_call_count: 0, sheets_sent_in_one_request: 0 } } });
  const { nodes, calls } = await openFixtureJob(job);
  assert.match(nodes["notice-banner"].textContent, /^这次没有生成成功：SYNTHETIC LOCAL RENDER ERROR/);
  assert.match(nodes["notice-banner"].textContent, /复用已有 AI 结果，本次未调用 AI/); assert.ok(nodes["notice-banner"].textContent.includes(job.recovery.source_job_id));
  assert.equal(nodes["job-message"].textContent, "SYNTHETIC LOCAL RENDER ERROR");
  assert.match(allText(nodes["evidence-content"]), /本次恢复失败/); assert.doesNotMatch(nodes["notice-banner"].textContent, /本次.*已发送|请求若已发出/);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 0);
});

test("recovery timing is current local work, never the inherited source AI time, and missing historical evidence does not invite a new request", async () => {
  const timings = timingFixture({ total_seconds: 8.25, scope: "render_recovery", note: "本地恢复" });
  timings.stages.forEach((stage) => { stage.status = "skipped"; stage.seconds = null; stage.percent = null; });
  Object.assign(timings.stages.find((stage) => stage.id === "render_highlight"), { status: "completed", seconds: 8.25, percent: 100 });
  const job = recoveredFixture({ timings }); const { nodes } = await openFixtureJob(job);
  assert.match(allText(nodes["timings-panel"]), /本次仅统计本地恢复/);
  assert.equal(withClass(timingRow(nodes["timings-panel"], "ai_request"), "timing-stage-duration")[0].textContent, "—");
  assert.doesNotMatch(allText(nodes["request-content"]), /AI 调用用时|AI 调用（旧记录）/);
  const minimal = recoveredFixture({ sampling: { sheets: [], frames: [] }, prompt: undefined, timings: undefined });
  minimal.ai.elapsed_seconds = 999; // Defensive legacy compatibility: never bill an inherited AI time to this local recovery.
  const other = await openFixtureJob(minimal);
  assert.match(allText(other.nodes["evidence-content"]), /本次未调用 AI/);
  assert.doesNotMatch(allText(other.nodes["request-content"]), /实际调用 AI 前|发送前|AI 调用（旧记录）|999 秒/);
  assert.doesNotMatch(allText(other.nodes["timings-panel"]), /AI 调用（旧记录）|999 秒/);
});
