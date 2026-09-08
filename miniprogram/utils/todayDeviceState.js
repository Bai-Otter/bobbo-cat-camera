function createTodayDeviceCards(devices = []) {
  return devices
    .filter((device) => device && device.sn)
    .map((device) => {
      const safeDevice = Object.assign({}, device);
      delete safeDevice.password;
      delete safeDevice.adminToken;
      return Object.assign({}, safeDevice, {
        diary: null,
        diaryLoading: true,
        diaryRefreshing: false,
        diaryError: "",
        latestTime: "--:--",
        clipCount: 0,
        todayEatCount: 0,
        eatMinutes: 0,
        actualEatingSeconds: 0,
        bowlPresenceSeconds: 0,
        feedingStatsVersion: "",
        feedingAnalysisState: "pending",
        feedingAnalysisUpdatedAt: 0,
        feedingCoverage: 0,
        feedingActivity: {
          state: "baseline_building",
          label: "基线建立中",
          score: null,
          validDayCount: 0,
          requiredValidDays: 7,
        },
        featuredClip: null,
      });
    });
}

function applyTodayDiary(card, diary) {
  const clips = diary && Array.isArray(diary.clips) ? diary.clips : [];
  const featuredClipId = diary ? diary.featuredClipId : "";
  const isV32 = !!(diary && diary.algorithmVersion === "feeding-stats-v3.2");
  return Object.assign({}, card, {
    diary: diary || null,
    diaryLoading: false,
    diaryRefreshing: false,
    diaryError: "",
    latestTime: clips.length > 0 ? clips[clips.length - 1].time || "--:--" : "--:--",
    clipCount: clips.length,
    todayEatCount: isV32
      ? Number(diary.mealCount == null ? diary.eatCount : diary.mealCount) || 0
      : 0,
    eatMinutes: isV32 ? Number(diary.eatMinutes) || 0 : 0,
    actualEatingSeconds: isV32 ? Number(diary.actualEatingSeconds) || 0 : 0,
    bowlPresenceSeconds: isV32 ? Number(diary.bowlPresenceSeconds) || 0 : 0,
    feedingStatsVersion: isV32 ? diary.algorithmVersion : "",
    feedingAnalysisState: isV32 ? (diary.analysisState || "ready") : "pending",
    feedingAnalysisUpdatedAt: isV32 ? Number(diary.analysisUpdatedAt || diary.updatedAt) || 0 : 0,
    feedingCoverage: isV32 ? Number(diary.coverage) || 0 : 0,
    feedingActivity: diary && diary.activity ? diary.activity : {
      state: "baseline_building",
      label: "基线建立中",
      score: null,
      validDayCount: 0,
      requiredValidDays: 7,
    },
    featuredClip: clips.find((clip) => clip.id === featuredClipId) || clips[0] || null,
  });
}

function updateTodayDeviceCard(cards = [], sn, patch) {
  return cards.map((card) => {
    if (!card || card.sn !== sn) return card;
    const nextPatch = typeof patch === "function" ? patch(card) : patch;
    return Object.assign({}, card, nextPatch || {});
  });
}

function reconcileTodayDeviceCards(currentCards = [], devices = []) {
  const currentBySn = currentCards.reduce((acc, card) => {
    if (card && card.sn) acc[card.sn] = card;
    return acc;
  }, {});

  return devices
    .filter((device) => device && device.sn)
    .map((device) => {
      const current = currentBySn[device.sn];
      if (!current) return createTodayDeviceCards([device])[0];
      const next = Object.assign({}, current, device);
      delete next.password;
      delete next.adminToken;
      return next;
    });
}

function selectDeviceBySn(devices = [], sn = "") {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  return devices.find((device) => device && device.sn === sn) || devices[0];
}

module.exports = {
  applyTodayDiary,
  createTodayDeviceCards,
  reconcileTodayDeviceCards,
  selectDeviceBySn,
  updateTodayDeviceCard,
};
