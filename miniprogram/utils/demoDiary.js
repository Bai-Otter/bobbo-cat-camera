const MIN_EFFECTIVE_SECONDS = 10;
const MAX_EFFECTIVE_SECONDS = 10 * 60;
const MEAL_WINDOW_SECONDS = 20 * 60;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

function parseTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const normalized = String(value).replace(/-/g, "/");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function secondsBetween(begin, end) {
  const beginDate = parseTime(begin);
  const endDate = parseTime(end);
  if (!beginDate || !endDate) return 0;
  return Math.max(0, Math.round((endDate - beginDate) / 1000));
}

function hasMotionEvent(record) {
  const fields = [
    record.Event,
    record.event,
    record.EventType,
    record.eventType,
    record.AlarmType,
    record.Type,
  ];
  return fields.some((field) => /motion|detect|alarm|move|event/i.test(String(field || "")));
}

function isEffectiveRecord(record) {
  const durationSec = secondsBetween(record.BeginTime || record.beginTime, record.EndTime || record.endTime);
  if (hasMotionEvent(record)) return durationSec > 0;
  return durationSec >= MIN_EFFECTIVE_SECONDS && durationSec <= MAX_EFFECTIVE_SECONDS;
}

function stableClipId(deviceSn, beginTime, fileName) {
  const raw = `${deviceSn || "device"}_${beginTime || "time"}_${fileName || "file"}`;
  return `clip_${raw.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function formatClock(value) {
  const date = parseTime(value);
  if (!date) return "--:--";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatCnDate(dateKey) {
  const date = parseTime(dateKey);
  if (!date) return "今日";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function titleForClip(index, beginTime) {
  const beginDate = parseTime(beginTime);
  const hour = beginDate ? beginDate.getHours() : 0;
  if (hour < 10) return "早餐小片段";
  if (hour < 15) return "午间小片段";
  if (hour < 20) return "晚餐小片段";
  return "夜宵小片段";
}

function toClip(record, index, deviceSn) {
  const beginTime = record.BeginTime || record.beginTime || "";
  const endTime = record.EndTime || record.endTime || "";
  const fileName = record.FileName || record.fileName || "";
  const durationSec = secondsBetween(beginTime, endTime);
  const eventType = record.Event || record.event || record.EventType || record.eventType || "";
  return {
    id: record.id || stableClipId(deviceSn, beginTime, fileName),
    beginTime,
    endTime,
    durationSec,
    fileName,
    eventType,
    title: record.title || titleForClip(index, beginTime),
    time: formatClock(beginTime),
    duration: durationSec,
    cover: record.cover || `/static/images/clip-${(index % 6) + 1}.svg`,
    isEffective: true,
    playbackParams: {
      startTime: beginTime,
      endTime,
      fileName,
    },
  };
}

function summarizeMeals(clips) {
  const sorted = clips
    .map((clip) => {
      const beginDate = parseTime(clip.beginTime);
      return { clip, time: beginDate ? beginDate.getTime() : 0 };
    })
    .filter((item) => item.time > 0)
    .sort((a, b) => a.time - b.time);

  const meals = [];
  for (const item of sorted) {
    const last = meals[meals.length - 1];
    if (!last || item.time - last.windowStart > MEAL_WINDOW_SECONDS * 1000) {
      meals.push({
        time: item.clip.time,
        name: `${item.clip.time} 的一餐`,
        actionText: "查看",
        clipIds: [item.clip.id],
        minutes: Math.max(1, Math.round(item.clip.durationSec / 60)),
        windowStart: item.time,
      });
    } else {
      last.clipIds.push(item.clip.id);
      last.minutes += Math.max(1, Math.round(item.clip.durationSec / 60));
    }
  }

  return meals.map(({ windowStart, ...meal }) => meal);
}

function buildDiaryFromRecords({ deviceSn = "", date = formatDateKey(), records = [] } = {}) {
  const clips = records
    .filter(isEffectiveRecord)
    .map((record, index) => toClip(record, index, deviceSn))
    .sort((a, b) => {
      const aDate = parseTime(a.beginTime);
      const bDate = parseTime(b.beginTime);
      return (aDate ? aDate.getTime() : 0) - (bDate ? bDate.getTime() : 0);
    });

  const meals = summarizeMeals(clips);
  const featured = clips.reduce((best, clip) => {
    if (!best) return clip;
    return clip.durationSec > best.durationSec ? clip : best;
  }, null);

  return {
    deviceSn,
    date,
    eatCount: meals.length,
    eatMinutes: meals.reduce((sum, meal) => sum + meal.minutes, 0),
    clipCount: clips.length,
    clips,
    meals,
    featuredClipId: featured ? featured.id : "",
    updatedAt: Date.now(),
  };
}

function buildFoodcast(diary) {
  const diaryDate = diary && diary.date ? diary.date : formatDateKey();
  const clips = diary && Array.isArray(diary.clips) ? diary.clips.filter((clip) => clip.isEffective !== false) : [];
  return {
    id: `foodcast_${diaryDate}_${Date.now()}`,
    title: `${formatCnDate(diaryDate)}吃播`,
    clipIds: clips.map((clip) => clip.id),
    totalDurationSec: clips.reduce((sum, clip) => sum + (Number(clip.durationSec) || 0), 0),
    createdAt: Date.now(),
  };
}

module.exports = {
  MIN_EFFECTIVE_SECONDS,
  MAX_EFFECTIVE_SECONDS,
  MEAL_WINDOW_SECONDS,
  buildDiaryFromRecords,
  buildFoodcast,
  formatDateKey,
  secondsBetween,
  summarizeMeals,
};
