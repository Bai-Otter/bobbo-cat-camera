function clean(value, limit = 2048) {
  return String(value == null ? "" : value).trim().slice(0, limit);
}

function alarmTime(raw = {}) {
  return clean(raw.occurredAt || raw.AlarmTime || raw.alarmTime || raw.Time || raw.time || raw.BeginTime || raw.beginTime, 64);
}

function alarmTimestamp(value) {
  if (!value) return 0;
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function imageUrl(raw = {}) {
  return clean(raw.snapshotUrl || raw.PicUrl || raw.picUrl || raw.PictureUrl || raw.pictureUrl || raw.ImageUrl || raw.imageUrl || raw.Url || raw.url, 4096);
}

function normalizeMotionAlarm(raw = {}) {
  const occurredAt = alarmTime(raw);
  const occurredAtMs = alarmTimestamp(occurredAt);
  const alarmType = clean(raw.alarmType || raw.AlarmType || raw.Event || raw.event || raw.Type || raw.type || "Motion", 80);
  const id = clean(raw.id || raw.AlarmID || raw.alarmId || raw.AlarmId || `${alarmType}-${occurredAtMs}`, 160);
  const haystack = `${alarmType} ${raw.Message || raw.message || ""}`;
  const label = /human|person|body|living|pet|cat|animal|activity|\u6d3b\u7269|\u4eba|\u5ba0\u7269|\u732b/i.test(haystack)
    ? "检测到活动"
    : "检测到移动";
  return { id, occurredAt, occurredAtMs, alarmType, label, imageUrl: imageUrl(raw) };
}

function normalizeMotionAlarmList(items = []) {
  const byId = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeMotionAlarm(raw);
    if (!item.id || !item.occurredAtMs) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => right.occurredAtMs - left.occurredAtMs);
}

function recordingBounds(record = {}) {
  const begin = alarmTimestamp(record.beginTime || record.BeginTime);
  let end = alarmTimestamp(record.endTime || record.EndTime);
  if (!end && begin) {
    end = begin + Math.max(0, Number(record.durationSec || record.duration) || 0) * 1000;
  }
  return { begin, end };
}

function matchMotionAlarmRecording(alarm = {}, recordings = [], toleranceMs = 15_000) {
  const at = Number(alarm.occurredAtMs) || alarmTimestamp(alarm.occurredAt);
  if (!at) return null;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const record of Array.isArray(recordings) ? recordings : []) {
    const { begin, end } = recordingBounds(record);
    if (!begin || !end || end <= begin) continue;
    if (at >= begin && at <= end) return record;
    const distance = Math.min(Math.abs(at - begin), Math.abs(at - end));
    if (distance < nearestDistance) {
      nearest = record;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= Math.max(0, Number(toleranceMs) || 0) ? nearest : null;
}

module.exports = {
  matchMotionAlarmRecording,
  normalizeMotionAlarm,
  normalizeMotionAlarmList,
};
