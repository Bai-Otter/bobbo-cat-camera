const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLiveObjectAlarmConfigPayload,
  enableMotionDetectConfig,
  motionAlarmDeliveryEnabled,
  tuneRecordConfig,
} = require("./officialConfig");

test("enableMotionDetectConfig flips known motion and recording linkage switches", () => {
  const motionConfig = {
    "Detect.MotionDetect": [
      {
        Enable: false,
        RecordLatch: 5,
        EventHandler: {
          Record: false,
          RecordEnable: false,
          MessageEnable: false,
          MsgtoNetEnable: false,
          SnapEnable: false,
          MultimediaMsgEnable: false,
          LogEnable: false,
          RecordMask: "0x00000000",
          SnapShotMask: "0x00000000",
        },
        AlarmOutEnable: false,
      },
    ],
  };

  const nextConfig = enableMotionDetectConfig(motionConfig);
  const item = nextConfig["Detect.MotionDetect"][0];

  assert.equal(item.Enable, true);
  assert.equal(item.EventHandler.Record, true);
  assert.equal(item.EventHandler.RecordEnable, true);
  assert.equal(item.EventHandler.MessageEnable, true);
  assert.equal(item.EventHandler.MsgtoNetEnable, true);
  assert.equal(item.EventHandler.SnapEnable, true);
  assert.equal(item.EventHandler.MultimediaMsgEnable, true);
  assert.equal(item.EventHandler.LogEnable, true);
  assert.equal(item.EventHandler.RecordMask, "0x00000001");
  assert.equal(item.EventHandler.SnapShotMask, "0x00000001");
  assert.equal(item.AlarmOutEnable, false);
  assert.equal(motionAlarmDeliveryEnabled(nextConfig), true);
  assert.equal(motionConfig["Detect.MotionDetect"][0].Enable, false);
});

test("tuneRecordConfig keeps safe packet length bounds", () => {
  const recordConfig = {
    Record: [
      {
        PacketLength: 120,
      },
    ],
  };

  const nextConfig = tuneRecordConfig(recordConfig);

  assert.equal(nextConfig.Record[0].PacketLength, 30);
  assert.equal(recordConfig.Record[0].PacketLength, 120);
});

test("buildLiveObjectAlarmConfigPayload enables official live-object alarm recording linkage", () => {
  const config = {
    "Detect.HumanDetect": [
      {
        Enable: false,
        EventHandler: {
          Record: false,
          RecordEnable: false,
          SnapshotEnable: false,
          MessageEnable: false,
        },
        AlarmOutEnable: false,
      },
    ],
  };

  const payload = buildLiveObjectAlarmConfigPayload("Detect.HumanDetect", config);
  const item = payload["Detect.HumanDetect"][0];

  assert.equal(payload.Name, "Detect.HumanDetect");
  assert.equal(item.Enable, true);
  assert.equal(item.EventHandler.Record, true);
  assert.equal(item.EventHandler.RecordEnable, true);
  assert.equal(item.EventHandler.SnapshotEnable, true);
  assert.equal(item.EventHandler.MessageEnable, true);
  assert.equal(item.AlarmOutEnable, true);
  assert.equal(config["Detect.HumanDetect"][0].Enable, false);
});
