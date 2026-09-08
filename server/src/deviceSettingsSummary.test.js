const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeviceSettingsSummary } = require("./deviceSettingsSummary");

test("device settings summary normalizes XM storage, recording and encode data", () => {
  const summary = buildDeviceSettingsSummary({
    storageInfo: {
      Ret: 100,
      StorageInfo: [{ Partition: [{ TotalSpace: 61058, RemainSpace: 21058, Status: 0 }] }],
    },
    storagePosition: { StoragePosition: { SATA: true, SD: false } },
    record: { Record: { RecordMask: "0x00000001", PacketLength: 30, PreRecord: 5 } },
    snapshot: { Snapshot: { SnapShotMask: "0x00000001" } },
    encode: { Encode: { MainFormat: { Video: { Resolution: "1080P", FPS: 20, Compression: "H.265" } } } },
  });

  assert.equal(summary.storage.type, "存储卡");
  assert.equal(summary.storage.available, true);
  assert.equal(summary.storage.totalBytes, 61058 * 1024 ** 2);
  assert.equal(summary.storage.usedBytes, 40000 * 1024 ** 2);
  assert.equal(summary.recording.continuous, true);
  assert.equal(summary.recording.snapshotEnabled, true);
  assert.equal(summary.recording.packetMinutes, 30);
  assert.equal(summary.picture.resolution, "1080P");
  assert.equal(summary.picture.fps, 20);
  assert.equal(summary.picture.codec, "H.265");
});

test("device settings summary detects array schedules and prefers the main stream", () => {
  const summary = buildDeviceSettingsSummary({
    storageInfo: {
      StorageInfo: [{
        Partition: [
          { TotalSpace: "0x0000e659", RemainSpace: "0x0000044e" },
          { TotalSpace: "0x00000405", RemainSpace: "0x000003e2" },
        ],
      }],
    },
    storagePosition: { "Storage.StoragePosition": { SATA: true } },
    record: {
      Record: {
        TimeSection: [["1 00:00:00-24:00:00"]],
        PacketLength: 30,
      },
    },
    snapshot: {
      "Storage.Snapshot": [{
        TimeSection: [["1 00:00:00-24:00:00"]],
      }],
    },
    encode: {
      "AVEnc.Encode": [{
        ExtraFormat: [{ Video: { Resolution: "HD1", FPS: 12, Compression: "H.264" } }],
        MainFormat: [{ Video: { Resolution: "4M", FPS: 20, Compression: "H.265" } }],
      }],
    },
  });

  assert.equal(summary.storage.available, true);
  assert.equal(summary.storage.totalBytes, (0xe659 + 0x405) * 1024 ** 2);
  assert.equal(summary.storage.freeBytes, (0x44e + 0x3e2) * 1024 ** 2);
  assert.equal(summary.recording.continuous, true);
  assert.equal(summary.recording.snapshotEnabled, true);
  assert.equal(summary.picture.resolution, "4M");
  assert.equal(summary.picture.fps, 20);
  assert.equal(summary.picture.codec, "H.265");
});
