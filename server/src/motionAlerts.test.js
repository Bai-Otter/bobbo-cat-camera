const test = require("node:test");
const assert = require("node:assert/strict");

const { matchMotionAlarmRecording, normalizeMotionAlarm, normalizeMotionAlarmList } = require("./motionAlerts");

test("motion alarm normalization exposes stable public fields", () => {
  assert.deepEqual(normalizeMotionAlarm({
    AlarmID: "alarm-1",
    AlarmTime: "2026-08-31 11:32:10",
    Event: "MotionDetect",
    PicUrl: "https://camera.example/alarm.jpg?token=secret",
  }), {
    id: "alarm-1",
    occurredAt: "2026-08-31 11:32:10",
    occurredAtMs: new Date("2026-08-31T11:32:10").getTime(),
    alarmType: "MotionDetect",
    label: "检测到移动",
    imageUrl: "https://camera.example/alarm.jpg?token=secret",
  });
});

test("motion alarm list removes duplicates and sorts newest first", () => {
  const alarms = normalizeMotionAlarmList([
    { AlarmID: "a", AlarmTime: "2026-08-31 10:00:00", Event: "Motion" },
    { AlarmID: "b", AlarmTime: "2026-08-31 11:00:00", Event: "HumanDetect" },
    { AlarmID: "a", AlarmTime: "2026-08-31 10:00:00", Event: "Motion" },
  ]);
  assert.deepEqual(alarms.map((item) => item.id), ["b", "a"]);
  assert.equal(alarms[0].label, "检测到活动");
});

test("motion alarm matches the recording that contains its timestamp", () => {
  const recording = { BeginTime: "2026-09-01 12:30:00", EndTime: "2026-09-01 12:36:00" };
  assert.equal(matchMotionAlarmRecording({ occurredAt: "2026-09-01 12:32:57" }, [recording]), recording);
});

test("motion alarm can match a recording edge within tolerance", () => {
  const recording = { beginTime: "2026-09-01 12:33:00", endTime: "2026-09-01 12:38:00" };
  assert.equal(matchMotionAlarmRecording({ occurredAt: "2026-09-01 12:32:57" }, [recording]), recording);
  assert.equal(matchMotionAlarmRecording({ occurredAt: "2026-09-01 12:32:30" }, [recording]), null);
});
