function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function enableNestedRecordingFlags(target) {
  if (!target || typeof target !== "object") return;
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === "boolean" && /(record|alarmout)/i.test(key) && /(enable|record|alarm)/i.test(key)) {
      target[key] = true;
      continue;
    }
    if (value && typeof value === "object") enableNestedRecordingFlags(value);
  }
}

function enableNestedAlarmFlags(target) {
  if (!target || typeof target !== "object") return;
  for (const [key, value] of Object.entries(target)) {
    if (typeof value === "boolean" && /(enable|record|alarm|message|push|snapshot|snap|pms)/i.test(key)) {
      target[key] = true;
      continue;
    }
    if (value && typeof value === "object") enableNestedAlarmFlags(value);
  }
}

function enableMotionDetectConfig(config) {
  const next = clone(config);
  const list = next["Detect.MotionDetect"];
  if (!Array.isArray(list) || list.length === 0) return next;
  const item = list[0];
  item.Enable = true;
  const handler = item.EventHandler && typeof item.EventHandler === "object"
    ? item.EventHandler
    : (item.EventHandler = {});
  // These are the vendor flags required for a motion event to leave the
  // camera. Keep audible/email/alarm-output actions untouched: the server
  // only needs the event, snapshot and local recording linkage.
  handler.Record = true;
  handler.RecordEnable = true;
  handler.MessageEnable = true;
  handler.MsgtoNetEnable = true;
  handler.SnapEnable = true;
  handler.SnapshotEnable = true;
  handler.MultimediaMsgEnable = true;
  handler.LogEnable = true;
  if (Object.hasOwn(handler, "RecordMask") && /^0x0+$/i.test(String(handler.RecordMask || ""))) {
    handler.RecordMask = "0x00000001";
  }
  if (Object.hasOwn(handler, "SnapShotMask") && /^0x0+$/i.test(String(handler.SnapShotMask || ""))) {
    handler.SnapShotMask = "0x00000001";
  }
  enableNestedRecordingFlags(handler);
  return next;
}

function motionAlarmDeliveryEnabled(config) {
  const item = config?.["Detect.MotionDetect"]?.[0];
  const handler = item?.EventHandler;
  if (!item || !handler) return false;
  return item.Enable === true &&
    handler.RecordEnable === true &&
    handler.MessageEnable === true &&
    handler.MsgtoNetEnable === true &&
    (handler.SnapEnable === true || handler.SnapshotEnable === true);
}

const LIVE_OBJECT_ALARM_CONFIG_CANDIDATES = [
  "Detect.HumanDetect",
  "Detect.HumanDetection",
  "Detect.HumanoidDetect",
  "Detect.PedestrianDetect",
  "Detect.PetDetect",
  "Detect.AnimalDetect",
  "Detect.LivingDetect",
  "Detect.SmartMotion",
  "Detect.MotionDetect",
];

function buildLiveObjectAlarmConfigPayload(name, config) {
  const next = clone(config);
  if (!Array.isArray(next[name])) {
    next[name] = [{}];
  }
  if (next[name].length === 0) {
    next[name].push({});
  }
  const item = next[name][0];
  item.Enable = true;
  enableNestedAlarmFlags(item);
  return {
    Name: name,
    ...next,
  };
}

function resolveLiveObjectAlarmConfigNames(ability) {
  const text = JSON.stringify(ability || {}).toLowerCase();
  if (!text || text === "{}") return LIVE_OBJECT_ALARM_CONFIG_CANDIDATES.slice();
  const supported = LIVE_OBJECT_ALARM_CONFIG_CANDIDATES.filter((name) => {
    const lower = name.toLowerCase();
    const shortName = lower.replace(/^detect\./, "");
    return text.includes(lower) || text.includes(shortName);
  });
  return supported.length > 0 ? supported : LIVE_OBJECT_ALARM_CONFIG_CANDIDATES.slice();
}

function tuneRecordConfig(config, maxPacketLength = 30) {
  const next = clone(config);
  const list = next.Record;
  if (!Array.isArray(list) || list.length === 0) return next;
  const item = list[0];
  if (typeof item.PacketLength === "number" && item.PacketLength > maxPacketLength) {
    item.PacketLength = maxPacketLength;
  }
  return next;
}

module.exports = {
  LIVE_OBJECT_ALARM_CONFIG_CANDIDATES,
  buildLiveObjectAlarmConfigPayload,
  enableMotionDetectConfig,
  motionAlarmDeliveryEnabled,
  resolveLiveObjectAlarmConfigNames,
  tuneRecordConfig,
};
