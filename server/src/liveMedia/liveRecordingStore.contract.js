const assert = require("node:assert/strict");

function recording(overrides = {}) {
  return {
    id: "record-1",
    ownerOpenid: "openid-owner",
    deviceSn: "SN-1",
    status: "starting",
    accessToken: "access-secret",
    fileId: "",
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 10000,
    ...overrides,
  };
}

async function exerciseContract(store) {
  assert.equal((await store.createJob(recording())).status, "starting");
  await assert.rejects(
    store.createJob(recording({ id: "record-duplicate", createdAt: 200 })),
    { code: "RECORDING_ALREADY_ACTIVE" }
  );
  await store.updateJob("record-1", {
    status: "ready",
    fileId: "cloud://secret/recording.mp4",
    outputSize: 1234,
    durationSec: 8,
    updatedAt: 300,
  });
  assert.equal((await store.getOwnedJob("openid-owner", "record-1")).fileId, "cloud://secret/recording.mp4");
  assert.equal(await store.getOwnedJob("openid-other", "record-1"), null);
  assert.equal((await store.getJob("record-1")).ownerOpenid, "openid-owner");
  assert.equal(await store.getJob("missing"), null);
  assert.equal((await store.findLatest("openid-owner", "SN-1")).id, "record-1");

  await store.createJob(recording({
    id: "record-exporting",
    deviceSn: "SN-5",
    status: "finalizing",
    createdAt: 350,
  }));
  await store.createJob(recording({ id: "record-after-export", deviceSn: "SN-5", createdAt: 360 }));
  await store.updateJob("record-exporting", { status: "ready", updatedAt: 370 });
  await store.updateJob("record-after-export", { status: "ready", updatedAt: 380 });

  await store.createJob(recording({ id: "record-starting", deviceSn: "SN-2", createdAt: 400 }));
  await store.createJob(recording({ id: "record-recording", deviceSn: "SN-3", status: "recording", createdAt: 500 }));
  await store.createJob(recording({ id: "record-finalizing", deviceSn: "SN-4", status: "finalizing", createdAt: 600 }));
  assert.equal(await store.recoverInterrupted(900), 3);
  for (const id of ["record-starting", "record-recording", "record-finalizing"]) {
    const saved = await store.getOwnedJob("openid-owner", id);
    assert.equal(saved.status, "failed");
    assert.equal(saved.errorCode, "RECORDING_INTERRUPTED");
    assert.equal(saved.updatedAt, 900);
  }
}

module.exports = { exerciseContract, recording };
