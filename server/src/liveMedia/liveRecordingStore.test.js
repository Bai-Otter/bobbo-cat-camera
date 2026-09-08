const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { LiveRecordingStore, publicRecording } = require("./liveRecordingStore");
const { exerciseContract, recording } = require("./liveRecordingStore.contract");

test("local recording store persists ownership, active uniqueness, latest lookup, and recovery", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-recording-store-"));
  const filePath = path.join(dir, "recordings.json");
  try {
    await exerciseContract(new LiveRecordingStore({ filePath }));
    const reopened = new LiveRecordingStore({ filePath });
    assert.equal((await reopened.getOwnedJob("openid-owner", "record-1")).status, "ready");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("public recording removes storage identifiers but keeps retry-save metadata", () => {
  assert.deepEqual(publicRecording(recording({
    status: "ready",
    fileId: "cloud://secret/recording.mp4",
    outputSize: 1234,
    durationSec: 8,
  })), {
    id: "record-1",
    deviceSn: "SN-1",
    status: "ready",
    accessToken: "access-secret",
    outputSize: 1234,
    durationSec: 8,
    errorCode: "",
    startedAt: 100,
    endedAt: 0,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 10000,
  });
});
