const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyTodayDiary,
  createTodayDeviceCards,
  reconcileTodayDeviceCards,
  selectDeviceBySn,
  updateTodayDeviceCard,
} = require("./todayDeviceState.js");

test("createTodayDeviceCards creates independent safe state for every owned device", () => {
  const cards = createTodayDeviceCards([
    { sn: "SN001", nickname: "客厅", token: "token-1", _online: true, password: "secret" },
    { sn: "SN002", nickname: "厨房", token: "token-2", _online: false, adminToken: "admin-secret" },
  ]);

  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.sn), ["SN001", "SN002"]);
  assert.equal(cards[0].diaryLoading, true);
  assert.equal(cards[1].diaryLoading, true);
  assert.equal(cards[0].password, undefined);
  assert.equal(cards[1].adminToken, undefined);
  assert.notEqual(cards[0], cards[1]);
});

test("applyTodayDiary derives one device summary and featured clip", () => {
  const [card] = createTodayDeviceCards([{ sn: "SN001", nickname: "客厅" }]);
  const next = applyTodayDiary(card, {
    deviceSn: "SN001",
    algorithmVersion: "feeding-stats-v3.2",
    analysisState: "ready",
    analysisUpdatedAt: 123456,
    coverage: 0.9,
    mealCount: 3,
    eatCount: 3,
    eatMinutes: 12,
    actualEatingSeconds: 701,
    bowlPresenceSeconds: 800,
    activity: { state: "baseline_building", label: "基线建立中", score: null, validDayCount: 1 },
    featuredClipId: "clip-2",
    clips: [
      { id: "clip-1", time: "08:10", cover: "first.jpg" },
      { id: "clip-2", time: "09:30", cover: "second.jpg" },
    ],
  });

  assert.equal(next.todayEatCount, 3);
  assert.equal(next.eatMinutes, 12);
  assert.equal(next.actualEatingSeconds, 701);
  assert.equal(next.bowlPresenceSeconds, 800);
  assert.equal(next.feedingActivity.label, "基线建立中");
  assert.equal(next.clipCount, 2);
  assert.equal(next.latestTime, "09:30");
  assert.equal(next.featuredClip.id, "clip-2");
  assert.equal(next.diaryLoading, false);
  assert.equal(next.diaryError, "");
  assert.equal(next.feedingStatsVersion, "feeding-stats-v3.2");
  assert.equal(next.feedingAnalysisState, "ready");
});

test("applyTodayDiary does not present legacy marker totals as V3.2 statistics", () => {
  const [card] = createTodayDeviceCards([{ sn: "SN001" }]);
  const next = applyTodayDiary(card, { eatCount: 9, actualEatingSeconds: 999, clips: [] });
  assert.equal(next.todayEatCount, 0);
  assert.equal(next.actualEatingSeconds, 0);
  assert.equal(next.feedingAnalysisState, "pending");
});

test("updateTodayDeviceCard only changes the requested device", () => {
  const cards = createTodayDeviceCards([{ sn: "SN001" }, { sn: "SN002" }]);
  const next = updateTodayDeviceCard(cards, "SN002", {
    diaryLoading: false,
    diaryError: "加载失败",
  });

  assert.equal(next[0], cards[0]);
  assert.notEqual(next[1], cards[1]);
  assert.equal(next[0].diaryLoading, true);
  assert.equal(next[1].diaryLoading, false);
  assert.equal(next[1].diaryError, "加载失败");
});

test("selectDeviceBySn selects the requested device and falls back to the first", () => {
  const devices = [{ sn: "SN001" }, { sn: "SN002" }];

  assert.equal(selectDeviceBySn(devices, "SN002").sn, "SN002");
  assert.equal(selectDeviceBySn(devices, "missing").sn, "SN001");
  assert.equal(selectDeviceBySn([], "SN002"), null);
});

test("reconcileTodayDeviceCards keeps loaded state and adds newly discovered devices", () => {
  const [existing] = createTodayDeviceCards([
    { sn: "SN001", nickname: "旧名称", token: "old-token", _online: false },
  ]);
  const loaded = applyTodayDiary(existing, {
    deviceSn: "SN001",
    algorithmVersion: "feeding-stats-v3.2",
    mealCount: 2,
    eatCount: 2,
    clips: [{ id: "clip-1", time: "10:20" }],
  });

  const cards = reconcileTodayDeviceCards([loaded], [
    { sn: "SN001", nickname: "客厅", token: "new-token", _online: true },
    { sn: "SN002", nickname: "厨房", token: "token-2", _online: false },
  ]);

  assert.equal(cards.length, 2);
  assert.equal(cards[0].nickname, "客厅");
  assert.equal(cards[0].token, "new-token");
  assert.equal(cards[0]._online, true);
  assert.equal(cards[0].todayEatCount, 2);
  assert.equal(cards[0].featuredClip.id, "clip-1");
  assert.equal(cards[0].diaryLoading, false);
  assert.equal(cards[1].sn, "SN002");
  assert.equal(cards[1].diaryLoading, true);
});

test("reconcileTodayDeviceCards removes devices absent from a successful refresh", () => {
  const existing = createTodayDeviceCards([{ sn: "SN001" }, { sn: "SN002" }]);

  const cards = reconcileTodayDeviceCards(existing, [{ sn: "SN002", _online: true }]);

  assert.deepEqual(cards.map((card) => card.sn), ["SN002"]);
});
