const test = require("node:test");
const assert = require("node:assert/strict");

const { CustomFoodcastService } = require("./customService");

function material(id, extra = {}) {
  return {
    id,
    kind: "meal",
    ownerOpenid: "u1",
    deviceSn: "SN",
    date: "2026-07-26",
    status: "ready",
    fileId: `cloud://env/${id}.mp4`,
    durationSec: 30,
    createdAt: 1_000,
    expiresAt: 20_000,
    ...extra,
  };
}

function harness() {
  const materials = new Map([["m1", material("m1")], ["m2", material("m2")]]);
  const jobs = new Map();
  const catalog = {
    async getMaterial(id) { return structuredClone(materials.get(id) || null); },
    async listMaterials({ ownerOpenid, deviceSn, nowMs }) {
      return [...materials.values()].filter((row) => row.ownerOpenid === ownerOpenid
        && row.deviceSn === deviceSn && row.status === "ready" && row.expiresAt > nowMs)
        .map((row) => structuredClone(row));
    },
    async countAvailableFoodcasts({ ownerOpenid, deviceSn, nowMs }) {
      return [...materials.values()].filter((row) => row.ownerOpenid === ownerOpenid
        && row.deviceSn === deviceSn && row.status === "ready" && row.expiresAt > nowMs
        && row.fileId && ["meal", "daily", "custom"].includes(row.kind)).length;
    },
    async putMaterial(value) { materials.set(value.id, structuredClone(value)); return value; },
    async putJob(value) { jobs.set(value.id, structuredClone(value)); return value; },
    async getJob(id) { return structuredClone(jobs.get(id) || null); },
    async claimJob(id, workerId, nowMs, leaseMs) {
      const value = jobs.get(id);
      if (!value || value.status !== "queued") return null;
      Object.assign(value, { status: "running", leaseOwner: workerId, leaseExpiresAt: nowMs + leaseMs });
      return structuredClone(value);
    },
    async updateJob(id, patch) { Object.assign(jobs.get(id), structuredClone(patch)); return this.getJob(id); },
  };
  const mediaStorage = {
    reads: 0,
    async getReadUrl(fileId) { this.reads += 1; return `https://media.test/${this.reads}/${encodeURIComponent(fileId)}`; },
  };
  const renderCalls = [];
  const coverCalls = [];
  const service = new CustomFoodcastService({
    catalog,
    mediaStorage,
    bgmLibrary: { get: (id) => id === "bgm-02" ? { id, filePath: "D:/bgm/02.m4a" } : null },
    renderOutput: async (input) => {
      renderCalls.push(structuredClone(input));
      return { fileId: "cloud://env/custom.mp4", durationSec: 15, outputSize: 100 };
    },
    renderCover: async (input) => {
      coverCalls.push(structuredClone(input));
      return { coverFileId: `cloud://env/${input.material.id}.jpg` };
    },
    now: () => 10_000,
    idFactory: () => "custom-1",
    workerId: "worker-1",
    leaseMs: 60_000,
    retentionMs: 100_000,
  });
  return { catalog, jobs, materials, mediaStorage, renderCalls, coverCalls, service };
}

test("renders custom materials in submitted order with no source audio", async () => {
  const h = harness();
  const job = await h.service.create({
    ownerOpenid: "u1",
    deviceSn: "SN",
    frameMode: "source",
    bgmId: "bgm-02",
    bgmVolume: 0.6,
    segments: [
      { materialId: "m2", trimStartSec: 2, trimEndSec: 12 },
      { materialId: "m1", trimStartSec: 0, trimEndSec: 5 },
    ],
  });
  await h.service.processJob(job.id);

  assert.deepEqual(h.renderCalls[0].segments.map((segment) => segment.materialId), ["m2", "m1"]);
  assert.equal(h.renderCalls[0].audioMode, "mix");
  assert.equal(h.renderCalls[0].bgmVolume, 0.6);
  assert.equal((await h.service.getPublicJob({ ownerOpenid: "u1", jobId: job.id })).status, "ready");
  assert.equal(await h.service.getPublicJob({ ownerOpenid: "other", jobId: job.id }), null);
});

test("listMaterials leaves media URLs for the signed public route without exposing storage file IDs", async () => {
  const h = harness();
  const first = await h.service.listMaterials({ ownerOpenid: "u1", deviceSn: "SN" });
  const second = await h.service.listMaterials({ ownerOpenid: "u1", deviceSn: "SN" });
  assert.equal(first[0].previewUrl, "");
  assert.equal(second[0].previewUrl, "");
  assert.equal(h.mediaStorage.reads, 0);
  assert.equal(Object.hasOwn(first[0], "fileId"), false);
});

test("available foodcast count stays owner and device scoped", async () => {
  const h = harness();
  h.materials.set("custom", material("custom", { kind: "custom" }));
  h.materials.set("foreign", material("foreign", { ownerOpenid: "u2" }));

  assert.equal(await h.service.countAvailableFoodcasts({ ownerOpenid: "u1", deviceSn: "SN" }), 3);
  assert.equal(await h.service.countAvailableFoodcasts({ ownerOpenid: "u2", deviceSn: "SN" }), 1);
});

test("legacy materials generate and persist a cover only on first request", async () => {
  const h = harness();
  const first = await h.service.ensureMaterialCover("m1");
  const second = await h.service.ensureMaterialCover("m1");

  assert.equal(first.coverFileId, "cloud://env/m1.jpg");
  assert.equal(second.coverFileId, "cloud://env/m1.jpg");
  assert.equal(h.coverCalls.length, 1);
  assert.equal(h.materials.get("m1").coverFileId, "cloud://env/m1.jpg");
});

test("create rejects another owner's material, expired material, and missing real BGM", async () => {
  const h = harness();
  h.materials.set("foreign", material("foreign", { ownerOpenid: "u2" }));
  h.materials.set("expired", material("expired", { expiresAt: 9_000 }));
  const base = { ownerOpenid: "u1", deviceSn: "SN", frameMode: "source", bgmId: "bgm-02", bgmVolume: 0.6 };
  await assert.rejects(h.service.create({ ...base, segments: [{ materialId: "foreign", trimStartSec: 0, trimEndSec: 5 }] }), { code: "CUSTOM_MATERIAL_OWNER_MISMATCH" });
  await assert.rejects(h.service.create({ ...base, segments: [{ materialId: "expired", trimStartSec: 0, trimEndSec: 5 }] }), { code: "CUSTOM_MATERIAL_EXPIRED" });
  await assert.rejects(h.service.create({ ...base, bgmId: "invented", segments: [{ materialId: "m1", trimStartSec: 0, trimEndSec: 5 }] }), { code: "BGM_NOT_FOUND" });
});
