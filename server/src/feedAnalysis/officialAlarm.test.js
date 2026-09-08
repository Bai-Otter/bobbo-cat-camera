const test = require("node:test");
const assert = require("node:assert/strict");

const {
  alarmTimeWindow,
  isFeedingTriggerAlarm,
  isLiveObjectAlarm,
  normalizeOfficialAlarm,
  selectNewDeviceLogAlarms,
  selectNewLiveObjectAlarms,
} = require("./officialAlarm");

test("isFeedingTriggerAlarm accepts motion and pet alarms but rejects human-only alarms", () => {
  assert.equal(isFeedingTriggerAlarm(normalizeOfficialAlarm({ AlarmType: "MotionDetect" })), true);
  assert.equal(isFeedingTriggerAlarm(normalizeOfficialAlarm({ AlarmType: "PetDetect" })), true);
  assert.equal(isFeedingTriggerAlarm(normalizeOfficialAlarm({ AlarmType: "HumanDetect" })), false);
});

test("normalizeOfficialAlarm recognizes official live-object alarm fields", () => {
  const alarm = normalizeOfficialAlarm({
    AlarmID: "alarm-1",
    AlarmType: "HumanDetect",
    AlarmTime: "2026-07-04 07:30:12",
    Message: "活物报警",
    PicUrl: "https://example.test/snap.jpg",
  });

  assert.equal(alarm.id, "alarm-1");
  assert.equal(alarm.alarmType, "HumanDetect");
  assert.equal(alarm.message, "活物报警");
  assert.equal(alarm.occurredAt, "2026-07-04 07:30:12");
  assert.equal(alarm.snapshotUrl, "https://example.test/snap.jpg");
  assert.equal(isLiveObjectAlarm(alarm), true);
});

test("normalizeOfficialAlarm recognizes the AlarmArray item schema returned by the device cloud", () => {
  const alarm = normalizeOfficialAlarm({
    AlarmId: "260715143910",
    AlarmEvent: "appEventHumanDetectAlarm:2",
    AlarmTime: "2026-07-15 14:39:11",
    PicInfo: {
      ObjName: "alarm-object.jpg",
      StorageBucket: "private-bucket",
    },
  });

  assert.equal(alarm.id, "260715143910");
  assert.equal(alarm.alarmType, "appEventHumanDetectAlarm:2");
  assert.equal(alarm.occurredAt, "2026-07-15 14:39:11");
  assert.equal(alarm.snapshotUrl, "");
  assert.equal(isLiveObjectAlarm(alarm), true);
});

test("alarmTimeWindow builds a replay search window around the alarm", () => {
  const alarm = normalizeOfficialAlarm({
    AlarmType: "PetDetect",
    AlarmTime: "2026-07-04 07:30:12",
    Message: "宠物活动",
  });

  assert.deepEqual(alarmTimeWindow(alarm), {
    beginTime: "2026-07-04 07:29:12",
    endTime: "2026-07-04 07:32:12",
  });
});

test("selectNewLiveObjectAlarms keeps only fresh live-object candidates", () => {
  const alarms = selectNewLiveObjectAlarms(
    [
      { AlarmID: "old", AlarmType: "HumanDetect", AlarmTime: "2026-07-04 07:29:00" },
      { AlarmID: "cat", AlarmType: "MotionDetect", AlarmTime: "2026-07-04 07:30:12", Message: "猫咪活动" },
      { AlarmID: "io", AlarmType: "DoorBell", AlarmTime: "2026-07-04 07:31:00" },
    ],
    { afterMs: Date.parse("2026-07-04T07:30:00+08:00") }
  );

  assert.deepEqual(
    alarms.map((alarm) => alarm.id),
    ["cat"]
  );
});

test("selectNewDeviceLogAlarms converts new HumanDetect EventStart logs into alarm candidates", () => {
  const alarms = selectNewDeviceLogAlarms({
    OPLogQuery: [
      { Position: 1103, Time: "2026-09-01 10:01:10", Type: "EventStart", Data: "HumanDetect,1" },
      { Position: 1104, Time: "2026-09-01 10:01:12", Type: "EventStop", Data: "HumanDetect,0" },
      { Position: 1105, Time: "2026-09-01 10:02:00", Type: "EventStart", Data: "VideoMotion,1" },
    ],
  }, { afterPosition: 1103 });

  assert.deepEqual(alarms.map((alarm) => alarm.id), ["device-log-1105"]);
  assert.equal(alarms[0].alarmType, "VideoMotion");
  assert.equal(alarms[0].logPosition, 1105);
  assert.equal(alarms[0].occurredAt, "2026-09-01 10:02:00");
  assert.equal(isLiveObjectAlarm(alarms[0]), true);
});
