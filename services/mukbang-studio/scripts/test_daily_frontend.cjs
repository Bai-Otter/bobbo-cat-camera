"use strict";

// Offline contract and lifecycle tests. Fixtures exist only in this test file.
// Run: node --test scripts/test_daily_frontend.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const kit = require("../web/daily.js");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/daily.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/daily.css"), "utf8");
const script = fs.readFileSync(path.join(root, "web/daily.js"), "utf8");
const origin = "http://127.0.0.1:8880";
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("random BGM exposes actual track and publish credits, not a fixed reference label", () => {
  const job = completed();
  job.result.story.validation = { bgm_added: true, narration_added: true, subtitles_burned_in: true };
  job.result.story.bgm = { label: "Plucky Daisy", rights_status: "cc_by_4_0", track: { attribution: "Kevin / CC BY 4.0" }, credits_url: `/api/jobs/${job.id}/files/story-music-credits.txt` };
  const output = kit.outputsFor(job, origin).story;
  assert.equal(output.bgm_label, "Plucky Daisy");
  assert.equal(output.music_rights, "cc_by_4_0");
  assert.equal(output.music_credit, "Kevin / CC BY 4.0");
  assert.ok(output.music_credits_url.endsWith("story-music-credits.txt"));
  assert.match(html, /href="\/static\/music.html"/);
});

test("music audition page renders all tracks safely and pauses other players", async () => {
  const status = new Element(); const tracks = new Element();
  tracks.querySelectorAll = () => find(tracks, n => ["AUDIO", "VIDEO"].includes(n.tagName));
  const document = {
    getElementById: id => id === "music-status" ? status : tracks,
    createElement: tag => { const n = new Element(tag); n.pause = () => { n.paused = true; }; return n; }
  };
  const rows = Array.from({ length: 12 }, (_, i) => ({ title: `<script>track ${i}</script>`, style_note: "轻巧", attribution: "CC credit", mood_tags: {categories:["warm","relaxed"],labels:["温馨亲昵","轻松日常"],scores:{warm:3,relaxed:2}}, audio_url: `/api/music/track-${i}/audio`, source_url: "https://incompetech.com/", preview_url: `/api/jobs/aabbccddeeff/files/local-postprocess/music-audition-v1/track-${i}/preview.mp4` }));
  await vm.runInNewContext(fs.readFileSync(path.join(root, "web/music.js"), "utf8"), { document, fetch: async () => ({ ok: true, json: async () => ({ count: 12, tracks: rows, mode:"story_mood_per_job" }) }) });
  assert.match(status.textContent, /12 首已接入/);
  const players = tracks.querySelectorAll();
  assert.equal(players.length, 24);
  assert.equal(find(tracks, n => n.tagName === "SCRIPT").length, 0);
  assert.match(status.textContent, /按剧情匹配/);
  assert.equal(find(tracks, n => n.className === "music-tag is-primary").length, 12);
  assert.equal(find(tracks, n => n.className === "music-tag").length, 12);
  players[0].events.play();
  assert.ok(players.slice(1).every(n => n.paused));
});

test("story mood match and uncertain fallback are visible, never injected as markup", async () => {
  const job = completed();
  job.result.story.story_mode = "inner_monologue";
  job.result.story.validation = { bgm_added:true, narration_added:true, subtitles_burned_in:true };
  job.result.story.bgm = { label:"Carefree", rights_status:"cc_by_4_0", match:{label:"轻松日常",mode:"relaxed_fallback",candidate_ids:["a","b","c"],classification:{reason:"<script>实际互动</script>"},fallback_reason:"剧情类别把握不足"} };
  const page = harness({jobs:[job],records:{[job.id]:job}}); await page.ready();
  const root = page.nodes["story-output"];
  assert.match(text(root), /轻松日常 → Carefree/);
  assert.match(text(root), /剧情类别把握不足/);
  assert.match(text(root), /3 首最高适配/);
  assert.equal(find(root, n => n.tagName === "SCRIPT").length, 0);
});

test("old service audition fallback never claims random production is active", async () => {
  const nodes = { "music-status": new Element(), "music-mode": new Element(), "music-tracks": new Element() };
  const calls = [];
  await vm.runInNewContext(fs.readFileSync(path.join(root, "web/music.js"), "utf8"), {
    document: { getElementById: id => nodes[id], createElement: tag => new Element(tag) },
    fetch: async url => { calls.push(url); return url === "/api/music" ? { status: 404, ok: false } : { ok: true, json: async () => ({ mode: "preview_only", count: 12, tracks: [] }) }; }
  });
  assert.match(nodes["music-status"].textContent, /尚待重启服务/);
  assert.match(nodes["music-mode"].textContent, /仍用旧固定BGM/);
  assert.deepEqual(calls, ["/api/music", "/static/music-catalog.local.json"]);
});

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.style = {}; this.attrs = {}; this.value = ""; this._text = ""; this.className = ""; this.hidden = false; this.disabled = false;
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach((value) => classes.add(value)), contains: (value) => classes.has(value) };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(_) { throw new Error("Unsafe model-text HTML assignment"); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ""; this.children = nodes; }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attrs[name] = value; }
  get firstElementChild() { return this.children[0]; }
  scrollIntoView() { this.scrolled = true; }
  focus() { this.focused = true; }
  play() { this.played = true; return Promise.resolve(); }
}
const text = (node) => [node.textContent, ...node.children.map(text)].join(" ");
const find = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => find(child, predicate))];
const videos = (node) => find(node, (item) => item.tagName === "VIDEO");
const buttons = (node) => find(node, (item) => item.tagName === "BUTTON");
const config = () => ({ configured: true, defaults: { target_duration: 40, min_duration: 30, max_duration: 50, sample_interval: 1 }, features: { dual_video: true, story_inner_monologue: true, photos: true, photo_gallery: true }, limits: { max_upload_mb: 512 }, prompt_library: { active_version_id: "P0004" } });
const completed = () => ({
  id: "aabbccddeeff", filename: "日常.mp4", status: "completed", stage: "整理完成", progress: 100, created_at: "2026-10-28T12:00:00+08:00", updated_at: "2026-10-28T12:01:00+08:00",
  options: { story_enabled: true }, ai: { call_count: 1 }, result: {
    highlight_status: "ready", video_url: "/api/jobs/aabbccddeeff/files/highlight.mp4", poster_url: "/api/jobs/aabbccddeeff/files/eating.jpg", video_duration: 40, clips: [{ start: 1, end: 41 }],
    story: { status: "ready", title: "等一下，我也来。", summary: "它走到人手旁，停下来闻了闻。", video_url: "/api/jobs/aabbccddeeff/files/story/story.mp4", poster_url: "/api/jobs/aabbccddeeff/files/story/poster.jpg", video_duration: 18.4, clips: [{ start: 40, end: 58.4 }] }
  }
});

function harness({ settings = config(), jobs = [], records = {}, postJob, route, search = "" } = {}) {
  const nodes = Object.fromEntries(ids.map((id) => [id, new Element()]));
  for (const [id, value] of Object.entries({ "target-duration": "40", "min-duration": "30", "max-duration": "50", "story-target": "35", "sample-interval": "1" })) nodes[id].value = value;
  nodes["generate-button"].append(new Element("span"), new Element("span"));
  const calls = []; const timers = new Map(); const local = new Map(); let nextTimer = 0;
  const location = { origin, href: `${origin}/daily${search}` };
  class MockFormData { constructor() { this.data = new Map(); } append(key, value) { this.data.set(key, value); } get(key) { return this.data.get(key); } }
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const override = route ? await route(url, options, calls) : null;
    if (override?.error) throw override.error;
    let data = override?.body; const status = override?.status || 200;
    if (!override) {
      if (url === "/api/config") data = settings;
      else if (url === "/api/jobs" && options.method === "POST") data = postJob;
      else if (url === "/api/jobs") data = { jobs };
      else if (/\/cancel$/.test(url)) data = { ...records[url.split("/")[3]], status: "cancelled" };
      else data = records[url.split("/")[3]];
    }
    if (data === undefined) throw new Error(`Unexpected test request: ${url}`);
    return { ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => data };
  };
  const context = {
    document: { getElementById: (id) => nodes[id] || null, createElement: (tag) => new Element(tag), title: "" },
    window: { location, localStorage: { getItem: (key) => local.get(key) || null, setItem: (key, value) => local.set(key, value) }, history: { replaceState: (_, __, url) => { location.href = String(url); } } },
    fetch, URL, FormData: MockFormData, console,
    setTimeout: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.createContext(context); vm.runInContext(script, context);
  return { nodes, calls, timers, context, ready: async () => { await tick(); await tick(); }, choose: (file = { name: "日常.mp4", size: 4000 }) => { nodes["video-file"].files = [file]; nodes["video-file"].events.change(); }, submit: () => nodes["upload-form"].events.submit({ preventDefault() {} }), poll: async () => { const [id, timer] = timers.entries().next().value || []; assert.ok(timer, "Expected status-only poll"); timers.delete(id); await timer.callback(); } };
}

test("page uses dedicated static assets and no fake statusbar or media", () => {
  assert.match(html, /\/static\/daily\.css/); assert.match(html, /\/static\/daily\.js/);
  assert.doesNotMatch(html, /https?:\/\/|9:41|01:28|08:26|12张|糯米|<img/);
  assert.match(html, /人宠合拍/); assert.match(html, /丑萌瞬间/);
  assert.match(html, /id="photo-outputs"/);
  assert.doesNotMatch(html, /暂未接入/);
});

test("actual voice and BGM are based on result, not current configured preset", async () => {
  const job = completed();
  Object.assign(job.result.story, {story_mode:"inner_monologue",style_version:"mi-inner-v1",
    validation:{narration_added:true,bgm_added:true,subtitles_burned_in:true},
    narration:{voice_label:"已确认的咪参考克隆"},bgm:{label:"参考轻音乐",rights_status:"local_preview_only"},inner_monologues:[]});
  const ui = harness({jobs:[job],records:{[job.id]:job}}); await ui.ready();
  const all=Object.values(ui.nodes).map(text).join(" ");
  assert.match(all,/已确认的咪参考克隆配音/);
  assert.match(all,/mi-inner-v1/); assert.match(all,/商用授权待确认/);
  job.result.story.validation.bgm_added=false;
  const without=kit.outputsFor(job,origin);
  assert.equal(without.story?.has_bgm ?? without.narrative?.has_bgm,false);
});

test("all DOM IDs referenced by implementation exist exactly once", () => {
  assert.equal(ids.length, new Set(ids).size);
  const refs = [...script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
  refs.forEach((id) => assert.ok(ids.includes(id), `Missing ${id}`));
});

test("media playback contains the full original frame; reduced motion is supported", () => {
  assert.match(css, /\.media-stage\.is-playing video\s*\{\s*object-fit:\s*contain/);
  assert.match(css, /prefers-reduced-motion/); assert.match(html, /role="alert"/); assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
});

test("assets and downloads only accept same-origin HTTP URLs without embedded credentials", () => {
  assert.equal(kit.safeUrl("/api/jobs/aabbccddeeff/files/highlight.mp4", origin), `${origin}/api/jobs/aabbccddeeff/files/highlight.mp4`);
  for (const value of ["javascript:alert(1)", "data:video/mp4,AAA", "https://other.test/cat.mp4", "//other.test/x", "http://name:secret@127.0.0.1:8880/x", "/api/config", "/", "/api/jobs/aabbccddeeff/cancel", "/api/jobs/aabbccddeeff/files/../../other", "", null]) assert.equal(kit.safeUrl(value, origin), null);
});

test("generation retains eating defaults and adds story within the SAME task", () => {
  assert.deepEqual(kit.generationOptions({ target: "40", min: "30", max: "50", interval: "1", story: "30" }), { target_duration: 40, min_duration: 30, max_duration: 50, sample_interval: 1, story_enabled: true, story_target_duration: 30, story_mode: "inner_monologue", photos_enabled: true, photo_mode: "gallery", use_active_prompt: true });
});

test("bad duration bounds and nonfinite values are blocked before submission", () => {
  const base = { target: 40, min: 30, max: 50, interval: 1, story: 30 };
  for (const change of [{ target: NaN }, { target: 121 }, { min: 41 }, { max: 39 }, { story: 2 }, { story: 61 }, { interval: 0 }, { interval: Infinity }]) assert.throws(() => kit.generationOptions({ ...base, ...change }));
});

test("duration formatting never invents missing durations or totals", () => {
  assert.equal(kit.durationLabel(40.2), "00:40"); assert.equal(kit.durationLabel(59.9), "01:00");
  assert.equal(kit.durationLabel(null), "--:--"); assert.equal(kit.durationLabel("40"), "--:--"); assert.equal(kit.durationLabel(-1), "--:--");
  assert.equal(kit.elapsedLabel(61.25), "1 分 1.25 秒"); assert.equal(kit.elapsedLabel(null), "未记录"); assert.equal(kit.elapsedLabel(.001), "<0.01 秒");
});

test("completed dual outputs expose their own real video, poster and duration", () => {
  const out = kit.outputsFor(completed(), origin);
  assert.equal(out.story.status, "ready"); assert.equal(out.story.duration, 18.4); assert.equal(out.eating.duration, 40);
  assert.match(out.story.poster_url, /story\/poster\.jpg$/); assert.match(out.eating.poster_url, /eating\.jpg$/);
});

test("narration and separate postprocess timing appear only on validated voiced stories", async () => {
  const job = completed();
  Object.assign(job.result.story, {
    story_mode: "inner_monologue",
    validation: { subtitles_burned_in: true, narration_added: true },
    local_postprocess: { kind: "paid_breeze_narration", seconds: 57.515,
      steps: [{ label: "付费配音生成与订阅核验", seconds: 12.891 }] }
  });
  const out = kit.outputsFor(job, origin);
  assert.equal(out.story.has_narration, true);
  assert.equal(out.story.local_postprocess_seconds, 57.515);
  assert.equal(out.story.postprocess_steps.length, 1);
  const h = harness({ jobs: [job], records: { [job.id]: job }, search: `?job=${job.id}` });
  await h.ready();
  const rendered = Object.values(h.nodes).map(text).join(" ");
  assert.match(rendered, /原声＋小布女宝宝配音＋字幕/);
  assert.match(rendered, /付费配音生成与订阅核验：12.89 秒/);
  assert.match(rendered, /不计入首次生成耗时；未重新识图/);
  delete job.result.story.validation.narration_added;
  assert.equal(kit.outputsFor(job, origin).story.has_narration, false);
});

test("no interaction is honest, and does not remove a successful eating video", () => {
  const job = completed(); job.result.story = { status: "not_found", reason: "只有小猫独自在吃饭。" };
  const out = kit.outputsFor(job, origin); assert.equal(out.story.status, "not_found"); assert.equal(out.eating.status, "ready");
});

test("story-only result is usable, without pretending an eating video exists", () => {
  const job = completed(); Object.assign(job.result, { highlight_status: "not_found", video_url: null });
  const out = kit.outputsFor(job, origin); assert.equal(out.story.status, "ready"); assert.equal(out.eating.status, "not_found");
});

test("historical eating results do not falsely claim story extraction", () => {
  const job = completed(); delete job.result.story; delete job.result.highlight_status; delete job.options.story_enabled;
  const out = kit.outputsFor(job, origin); assert.equal(out.eating.status, "ready"); assert.equal(out.story.status, "historical"); assert.match(out.story.reason, /历史任务未提取小剧场/);
});

test("invalid ready URLs are not advertised as success", () => {
  const job = completed(); job.result.video_url = "https://untrusted.test/a.mp4"; job.result.story.video_url = "javascript:alert(1)";
  const out = kit.outputsFor(job, origin); assert.equal(out.eating.status, "failed"); assert.equal(out.story.status, "invalid");
});

test("no data and nonterminal jobs remain pending rather than fake ready", () => {
  for (const job of [null, { status: "analyzing", options: { story_enabled: true } }]) {
    const out = kit.outputsFor(job, origin); assert.equal(out.story.status, "pending"); assert.equal(out.eating.status, "pending");
  }
});

test("timing rows preserve individual story stages and never count pending as zero", () => {
  const timings = { schema_version: 1, available: true, stages: [{ id: "extract_frames", seconds: 1.2, status: "completed" }, { id: "render_story", seconds: 0, status: "pending" }, { id: "ai_request", seconds: 45.5, status: "completed" }] };
  const rows = kit.timingRows(timings); assert.equal(rows[0].seconds, 1.2); assert.equal(rows[1].seconds, null); assert.equal(rows[1].label, "剪辑人宠小故事"); assert.equal(rows[2].seconds, 45.5);
  assert.deepEqual(kit.timingRows({ available: false }), []);
});

test("boot connects only to read-only config/history and keeps generation disabled without file", async () => {
  const page = harness(); await page.ready();
  assert.deepEqual(page.calls.map((call) => call.url), ["/api/config", "/api/jobs"]);
  assert.equal(page.nodes["generate-button"].disabled, true); assert.match(page.nodes["prompt-standard"].textContent, /P0004/);
  assert.equal(page.nodes["history-list"].children.length, 0);
});

test("unsupported old server and missing model configuration never submit", async () => {
  for (const change of [{ features: {} }, { features: { dual_video: true } }, { features: { dual_video: true, story_inner_monologue: true } }, { configured: false }]) {
    const page = harness({ settings: { ...config(), ...change } }); await page.ready(); page.choose();
    assert.equal(page.nodes["generate-button"].disabled, true); await page.submit();
    assert.equal(page.calls.filter((call) => call.options.method === "POST").length, 0);
  }
});

test("empty, oversized and unsupported uploads are rejected without API writes", async () => {
  const page = harness(); await page.ready();
  for (const file of [{ name: "a.txt", size: 12 }, { name: "a.mp4", size: 0 }, { name: "a.mp4", size: 513 * 1024 * 1024 }]) {
    page.choose(file); assert.equal(page.nodes["generate-button"].disabled, true); assert.equal(page.nodes["form-error"].hidden, false);
  }
  assert.equal(page.calls.filter((call) => call.options.method === "POST").length, 0);
});

test("a click submits file + dual options once and does not issue a separate story call", async () => {
  const job = { id: "aabbccddeeff", filename: "日常.mp4", status: "queued", options: { story_enabled: true }, ai: { call_count: 0 } };
  const page = harness({ postJob: job }); await page.ready(); page.choose();
  assert.equal(page.nodes["generate-button"].disabled, false); await page.submit(); await page.submit();
  const writes = page.calls.filter((call) => call.options.method === "POST"); assert.equal(writes.length, 1); assert.equal(writes[0].url, "/api/jobs");
  assert.equal(writes[0].options.body.get("file").name, "日常.mp4"); assert.equal(writes[0].options.body.get("video"), undefined);
  const options = JSON.parse(writes[0].options.body.get("options")); assert.equal(options.story_enabled, true); assert.equal(options.use_active_prompt, true); assert.equal(options.prompt, undefined);
  assert.equal(options.photos_enabled, true);
  assert.equal(options.photo_mode, "gallery");
  assert.match(page.nodes["job-ai-count"].textContent, /0 次/); assert.equal(page.nodes["generate-button"].disabled, true);
});

test("successful history renders two actual players and source-specific duration", async () => {
  const job = completed(); const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.equal(videos(page.nodes["story-output"]).length, 1); assert.equal(videos(page.nodes["eating-output"]).length, 1);
  assert.match(text(page.nodes["story-output"]), /00:18/); assert.match(text(page.nodes["eating-output"]), /00:40/);
  assert.match(text(page.nodes["eating-output"]), /1 段精选/); assert.doesNotMatch(text(page.nodes["eating-output"]), /3顿|累计/);
  const video = videos(page.nodes["story-output"])[0]; assert.equal(video.controls, false);
  await buttons(page.nodes["story-output"])[0].events.click(); assert.equal(video.controls, true); assert.equal(video.played, true);
});

test("partial video failures never show a green all-complete banner", async () => {
  const job = completed();
  job.stage = "生成完成";
  job.result.highlight_status = "invalid";
  job.result.story.status = "invalid";
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(page.nodes["job-stage"].textContent, /部分完成/);
  assert.match(page.nodes["job-notice"].className, /is-error/);
  assert.doesNotMatch(page.nodes["job-notice"].className, /is-complete/);
  assert.equal(page.calls.filter(call => call.options.method === "POST").length, 0);
});

test("model titles and reasons are plain text, never injected HTML", async () => {
  const job = completed(); job.result.story.title = "<img src=x onerror=alert(1)>";
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(text(page.nodes["story-output"]), /<img src=x/); assert.equal(find(page.nodes["story-output"], (node) => node.tagName === "IMG").length, 0);
});

test("history lacking story shows the historical disclosure while eating still plays", async () => {
  const job = completed(); delete job.options.story_enabled; delete job.result.story;
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(text(page.nodes["story-output"]), /历史任务未提取小剧场/); assert.equal(videos(page.nodes["story-output"]).length, 0); assert.equal(videos(page.nodes["eating-output"]).length, 1);
});

test("status polls are GET-only and arriving results become playable", async () => {
  const job = completed(); const record = { ...job, status: "analyzing", result: undefined, ai: { call_count: 1 } };
  const records = { [job.id]: record }; const page = harness({ jobs: [record], records }); await page.ready();
  assert.equal(videos(page.nodes["eating-output"]).length, 0); records[job.id] = job; await page.poll();
  assert.equal(videos(page.nodes["eating-output"]).length, 1); assert.equal(videos(page.nodes["story-output"]).length, 1);
  assert.equal(page.calls.filter((call) => call.options.method === "POST").length, 0); assert.equal(page.timers.size, 0);
});

test("temporary polling failure retries only task status and preserves the task", async () => {
  const job = { ...completed(), status: "analyzing", result: undefined };
  let reads = 0;
  const page = harness({ jobs: [job], records: { [job.id]: job }, route: (url) => url === `/api/jobs/${job.id}` && ++reads > 1 ? { error: new Error("网络暂断") } : null });
  await page.ready(); await page.poll();
  assert.match(page.nodes["job-message"].textContent, /不会重发 AI 请求/); assert.equal(page.calls.filter((call) => call.options.method === "POST").length, 0); assert.equal(page.timers.size, 1);
});

test("cancel targets only selected job and stops status polling on confirmed cancellation", async () => {
  const job = { ...completed(), status: "analyzing", result: undefined };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready(); await page.nodes["cancel-job"].events.click();
  const writes = page.calls.filter((call) => call.options.method === "POST"); assert.equal(writes.length, 1); assert.equal(writes[0].url, `/api/jobs/${job.id}/cancel`);
  assert.equal(page.nodes["cancel-job"].hidden, true); assert.equal(page.timers.size, 0);
});

test("uncertain submission locks resubmit; retry is never automatic", async () => {
  const page = harness({ route: (url, options) => url === "/api/jobs" && options.method === "POST" ? { error: new Error("连接中断") } : null });
  await page.ready(); page.choose(); await page.submit(); await page.submit();
  assert.equal(page.calls.filter((call) => call.options.method === "POST").length, 1); assert.equal(page.nodes["generate-button"].disabled, true); assert.equal(page.nodes["resolve-upload"].hidden, false);
  assert.match(page.nodes["form-error"].textContent, /不会自动重试/);
});

test("failed jobs retain honest error state and no playable fiction", async () => {
  const job = { id: "aabbccddeeff", filename: "失败.mp4", status: "failed", error: "AI 返回未完整结束", options: { story_enabled: true }, ai: { call_count: 1 } };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(page.nodes["job-message"].textContent, /AI 返回未完整结束/); assert.equal(videos(page.nodes["story-output"]).length + videos(page.nodes["eating-output"]).length, 0);
  assert.match(page.nodes["job-ai-count"].textContent, /1 次/); assert.equal(page.nodes["total-time"].textContent, "未记录");
});

test("query-selected real record wins over newest history and debug link carries identity", async () => {
  const old = { ...completed(), id: "112233445566", filename: "旧记录.mp4" }; const latest = completed();
  const page = harness({ jobs: [latest, old], records: { [latest.id]: latest, [old.id]: old }, search: `?job=${old.id}` }); await page.ready();
  assert.equal(page.nodes["prompt-debug-link"].href, `/?job=${old.id}`); assert.match(page.context.window.location.href, new RegExp(old.id));
});

test("inner monologue upgrades one existing card with source/output times and safe SRT download", async () => {
  const job = completed();
  Object.assign(job.result.story, { story_mode: "inner_monologue", video_duration: 35, validation: { subtitles_burned_in: true },
    duration_goal: { target: 35, met: true }, subtitle_url: "/api/jobs/aabbccddeeff/files/interaction-story.srt",
    inner_monologues: [{ text: "<script>literal caption</script>", output_start: 2, output_end: 4.5, source_start: 22, source_end: 24.5 }] });
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready(); await page.ready();
  assert.equal(videos(page.nodes["story-output"]).length, 1);
  assert.equal(videos(page.nodes["eating-output"]).length, 1);
  assert.match(text(page.nodes["story-output"]), /原声＋内心独白字幕/);
  assert.match(text(page.nodes["story-output"]), /目标 35 秒 · 成片 35 秒/);
  assert.match(text(page.nodes["story-output"]), /2 秒—4.5 秒/);
  assert.match(text(page.nodes["story-output"]), /对应原片 22 秒—24.5 秒/);
  assert.match(text(page.nodes["story-output"]), /<script>literal caption<\/script>/);
  assert.ok(find(page.nodes["story-output"], (node) => node.tagName === "A").some((node) => node.href.endsWith(".srt")));
  assert.equal(page.calls.some((call) => call.options.method === "POST"), false);
});

test("old story is not relabeled as a subtitled version and unsafe subtitle URLs are rejected", async () => {
  const job = completed();
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready(); await page.ready();
  assert.match(text(page.nodes["story-output"]), /原声历史版 · 未加独白字幕/);
  Object.assign(job.result.story, { story_mode: "inner_monologue", validation: { subtitles_burned_in: true }, subtitle_url: "https://other.test/a.srt" });
  assert.equal(kit.outputsFor(job, origin).story.subtitle_url, null);
});

test("offline caption restyle time stays separate from original generation time", async () => {
  const job = completed();
  job.result.story.local_postprocess = { kind: "subtitle_style_only", seconds: 12.5, additional_ai_calls: 0 };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(text(page.nodes["story-output"]), /另做字幕排版调整/);
  assert.match(text(page.nodes["story-output"]), /不计入首次生成耗时；未重新调用 AI/);
  delete job.result.story.local_postprocess;
  assert.equal(kit.outputsFor(job, origin).story.local_postprocess_seconds, null);
});

test("explicit local subtitle timing repair is not mislabeled as original AI success or restyling", async () => {
  const job = completed();
  job.result.story.local_postprocess = { kind: "subtitle_timing_fix", seconds: 21.2, additional_ai_calls: 0 };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(text(page.nodes["story-output"]), /另做本地字幕时长修正/);
  assert.match(text(page.nodes["story-output"]), /不计入首次生成耗时；未重新调用 AI/);
  assert.doesNotMatch(text(page.nodes["story-output"]), /另做字幕排版调整/);
});

test("two real photo cards preserve original images, safe downloads and plain-text evidence", async () => {
  const job = completed(); job.options.photos_enabled = true;
  job.result.photos = Object.fromEntries(["portrait", "ugly_cute"].map((category) => [category, {
    status: "ready", image_url: `/api/jobs/${job.id}/files/photos/${category}.png`, title: "<img onerror=bad>可爱",
    reason: "<script>原片中的具体特点</script>", time: 12, frame_id: "F0013", width: 2560, height: 1440,
    sample_url: `/api/jobs/${job.id}/files/samples/frame-00013.jpg`
  }]));
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  const root = page.nodes["photo-outputs"];
  assert.equal(find(root, (n) => n.tagName === "IMG").length, 2);
  assert.equal(find(root, (n) => n.tagName === "SCRIPT").length, 0);
  assert.equal(find(root, (n) => n.attrs.download).length, 2);
  assert.match(text(root), /原片 12 秒/); assert.match(text(root), /<script>原片/);
  assert.match(css, /\.photo-image-link img\s*\{[^}]*object-fit:\s*contain/);
  assert.equal(page.calls.filter((c) => c.options.method === "POST").length, 0);
});

test("photo absence, invalid URL, errors and old records never show fake pictures", async () => {
  const job = completed();
  assert.ok(kit.photosFor(job, origin).every((p) => p.status === "historical"));
  assert.ok(kit.photosFor(null, origin).every((p) => p.status === "empty"));
  assert.ok(kit.photosFor({ status: "analyzing" }, origin).every((p) => p.status === "pending"));
  job.options.photos_enabled = true;
  job.result.photos = { portrait: { status: "not_found", reason: "人物未露脸" }, ugly_cute: { status: "ready", image_url: "javascript:alert(1)" } };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.equal(find(page.nodes["photo-outputs"], (n) => n.tagName === "IMG").length, 0);
  assert.match(text(page.nodes["photo-outputs"]), /人物未露脸/);
  assert.match(text(page.nodes["photo-outputs"]), /照片地址无效/);
  delete job.result.photos;
  assert.ok(kit.photosFor(job, origin).every((p) => p.status === "failed"));
});

test("gallery displays one portrait and four unique original-photo downloads", async () => {
  const job = completed(); Object.assign(job.options, { photos_enabled: true, photo_mode: "gallery" });
  const pick = (name) => ({ status: "ready", image_url: `/api/jobs/${job.id}/files/photos/${name}.png`, title: name, reason: "真实源帧", difference: "<script>各自不同的表情</script>", time: 12 });
  job.result.photos = { portrait: pick("portrait"), ugly_cute: { status: "ready", items: [1,2,3,4].map(i => pick(`ugly_cute_0${i}`)), count_goal: { minimum: 4, actual: 4, met: true } } };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  const root = page.nodes["photo-outputs"];
  assert.equal(find(root, n => n.tagName === "IMG").length, 5);
  const downloads = find(root, n => n.attrs.download).map(n => n.attrs.download);
  assert.equal(new Set(downloads).size, 5);
  assert.match(text(root), /至少 4 张/);
  assert.match(text(root), /各自不同的表情/);
  assert.equal(find(root, n => n.tagName === "SCRIPT").length, 0);
});

test("single-photo backend cannot silently accept a gallery upload", async () => {
  const settings = config(); delete settings.features.photo_gallery;
  const page = harness({ settings }); await page.ready(); page.choose(); await page.submit();
  assert.equal(page.nodes["generate-button"].disabled, true);
  assert.equal(page.calls.filter(c => c.options.method === "POST").length, 0);
});

test("gallery shortfall is visible rather than claiming four photos", async () => {
  const job = completed(); Object.assign(job.options, { photos_enabled: true, photo_mode: "gallery" });
  job.result.photos = { portrait: { status: "not_found", reason: "无人" }, ugly_cute: {
    status: "ready", count_goal: { minimum: 4, actual: 1, met: false, shortfall_reason: "猫只在一张采样中出现" },
    items: [{ status: "ready", image_url: `/api/jobs/${job.id}/files/photos/ugly_cute_01.png`, time: 1 }]
  } };
  const page = harness({ jobs: [job], records: { [job.id]: job } }); await page.ready();
  assert.match(text(page.nodes["photo-outputs"]), /1 张 \/ 目标至少 4 张/);
  assert.match(text(page.nodes["photo-outputs"]), /猫只在一张采样中出现/);
});
