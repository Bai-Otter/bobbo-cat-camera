const { parseTime } = require("./model");
const { formatDeviceDateTime } = require("./deviceTime");

const LIVE_OBJECT_ALARM_PATTERN =
  /cat|pet|animal|living|human|humanoid|person|body|motion|detect|\u732b|\u5ba0\u7269|\u52a8\u7269|\u6d3b\u7269|\u4eba\u5f62|\u4eba\u4f53|\u4eba|\u79fb\u52a8|\u4fa6\u6d4b|\u68c0\u6d4b/i;
const NON_LIVE_OBJECT_ALARM_PATTERN =
  /door|lock|bell|battery|offline|storage|disk|sd|\bio\b|i\/o|sensor|\u95e8|\u9501|\u95e8\u94c3|\u7535\u91cf|\u79bb\u7ebf|\u5b58\u50a8|\u78c1\u76d8|\u4e32\u53e3/i;

function firstValue(values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function formatDeviceTime(date) {
  return formatDeviceDateTime(date);
}

function parseAlarmDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1000000000000 ? value * 1000 : value;
    return new Date(ms);
  }
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    const ms = numeric < 1000000000000 ? numeric * 1000 : numeric;
    return new Date(ms);
  }
  return parseTime(text);
}

function classifyAlarmSource(alarmType = "", message = "") {
  const text = `${alarmType} ${message}`.toLowerCase();
  if (/pet|animal|living|\u732b|\u5ba0\u7269|\u52a8\u7269/.test(text)) return "pet";
  if (/motion|\u79fb\u52a8/.test(text)) return "motion";
  if (/human|humanoid|person|body|\u4eba\u5f62|\u4eba\u4f53/.test(text)) return "human";
  return "unknown";
}

function normalizeOfficialAlarm(raw = {}) {
  const alarmType = String(firstValue([
    raw.AlarmType,
    raw.alarmType,
    raw.AlarmEvent,
    raw.alarmEvent,
    raw.Event,
    raw.event,
    raw.Type,
    raw.type,
    raw.Name,
    raw.name,
    raw.MsgType,
    raw.msgType,
  ]) || "").trim();
  const message = String(firstValue([
    raw.Message,
    raw.message,
    raw.Msg,
    raw.msg,
    raw.Content,
    raw.content,
    raw.Description,
    raw.description,
    raw.Title,
    raw.title,
  ]) || "").trim();
  const alarmDate = parseAlarmDate(firstValue([
    raw.AlarmTime,
    raw.alarmTime,
    raw.BeginTime,
    raw.beginTime,
    raw.StartTime,
    raw.startTime,
    raw.Time,
    raw.time,
    raw.CreateTime,
    raw.createTime,
    raw.createdAt,
    raw.timestamp,
  ]));
  const occurredAtMs = alarmDate && !Number.isNaN(alarmDate.getTime()) ? alarmDate.getTime() : 0;
  const id = String(firstValue([
    raw.AlarmID,
    raw.AlarmId,
    raw.alarmId,
    raw.eventId,
    raw.id,
    raw.ID,
  ]) || `${alarmType || "alarm"}-${occurredAtMs || "unknown"}-${message}`).trim();

  return {
    id,
    alarmType,
    message,
    sourceType: classifyAlarmSource(alarmType, message),
    occurredAt: occurredAtMs ? formatDeviceTime(new Date(occurredAtMs)) : "",
    occurredAtMs,
    snapshotUrl: String(firstValue([
      raw.PicUrl,
      raw.picUrl,
      raw.Picture,
      raw.picture,
      raw.SnapshotUrl,
      raw.snapshotUrl,
      raw.ImageUrl,
      raw.imageUrl,
      raw.url,
    ]) || "").trim(),
    raw,
  };
}

function isLiveObjectAlarm(alarmLike) {
  const alarm = alarmLike && alarmLike.raw ? alarmLike : normalizeOfficialAlarm(alarmLike);
  const haystack = `${alarm.alarmType} ${alarm.message}`.trim();
  if (!haystack) return false;
  if (NON_LIVE_OBJECT_ALARM_PATTERN.test(haystack)) return false;
  return LIVE_OBJECT_ALARM_PATTERN.test(haystack);
}

function alarmTimeWindow(alarmLike, { beforeMs = 60 * 1000, afterMs = 120 * 1000 } = {}) {
  const alarm = alarmLike && alarmLike.raw ? alarmLike : normalizeOfficialAlarm(alarmLike);
  const center = alarm.occurredAtMs || Date.now();
  return {
    beginTime: formatDeviceTime(new Date(center - beforeMs)),
    endTime: formatDeviceTime(new Date(center + afterMs)),
  };
}

function selectNewLiveObjectAlarms(rawAlarms = [], { afterMs = 0 } = {}) {
  const cursor = Number(afterMs) || 0;
  return rawAlarms
    .map(normalizeOfficialAlarm)
    .filter((alarm) => alarm.occurredAtMs > cursor)
    .filter(isLiveObjectAlarm)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);
}

function isFeedingTriggerAlarm(alarmLike) {
  const alarm = alarmLike && alarmLike.raw ? alarmLike : normalizeOfficialAlarm(alarmLike);
  return alarm.sourceType === "motion" || alarm.sourceType === "pet";
}

function extractDeviceLogEntries(payload) {
  const entries = [];
  const seen = new Set();
  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;
    const position = Number(firstValue([value.Position, value.position, value.LogPosition, value.logPosition]));
    const time = firstValue([value.Time, value.time, value.AlarmTime, value.alarmTime]);
    const data = firstValue([value.Data, value.data, value.Message, value.message]);
    if (Number.isFinite(position) && time && data !== undefined) {
      const key = `${position}:${time}:${data}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(value);
      }
      return;
    }
    Object.values(value).forEach(visit);
  }
  visit(payload);
  return entries;
}

function normalizeDeviceLogAlarm(raw = {}) {
  const position = Number(firstValue([raw.Position, raw.position, raw.LogPosition, raw.logPosition]));
  const data = String(firstValue([raw.Data, raw.data, raw.Message, raw.message]) || "").trim();
  const alarmType = String(data.split(",")[0] || "").trim();
  return {
    ...normalizeOfficialAlarm({
      ...raw,
      AlarmID: Number.isFinite(position) ? `device-log-${position}` : undefined,
      AlarmType: alarmType,
      AlarmTime: firstValue([raw.Time, raw.time, raw.AlarmTime, raw.alarmTime]),
      Message: data,
    }),
    logPosition: Number.isFinite(position) ? position : 0,
    source: "device-log",
  };
}

function selectNewDeviceLogAlarms(payload, { afterPosition = 0 } = {}) {
  const cursor = Number(afterPosition) || 0;
  return extractDeviceLogEntries(payload)
    .filter((entry) => Number(firstValue([entry.Position, entry.position, entry.LogPosition, entry.logPosition])) > cursor)
    .filter((entry) => /eventstart/i.test(String(firstValue([entry.Type, entry.type]) || "")))
    .map(normalizeDeviceLogAlarm)
    .filter(isLiveObjectAlarm)
    .sort((a, b) => a.logPosition - b.logPosition);
}

module.exports = {
  alarmTimeWindow,
  extractDeviceLogEntries,
  formatDeviceTime,
  isFeedingTriggerAlarm,
  isLiveObjectAlarm,
  normalizeDeviceLogAlarm,
  normalizeOfficialAlarm,
  selectNewDeviceLogAlarms,
  selectNewLiveObjectAlarms,
};
