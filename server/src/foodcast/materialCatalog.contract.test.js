const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { MaterialCatalog } = require("./materialCatalog");
const { CloudMaterialCatalog } = require("./cloudMaterialCatalog");

function interval(id = "i1") {
  return {
    id,
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    date: "2026-07-26",
    startMs: 1_000,
    endMs: 2_000,
  };
}

function job(id = "j1") {
  return {
    id,
    jobType: "meal",
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    date: "2026-07-26",
    status: "queued",
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function material(id, extra = {}) {
  return {
    id,
    kind: "meal",
    ownerOpenid: "owner-1",
    deviceSn: "SN-1",
    date: "2026-07-26",
    status: "ready",
    fileId: `cloud://env/${id}.mp4`,
    durationSec: 30,
    createdAt: 1_000,
    expiresAt: 20_000,
    ...extra,
  };
}

function createFakeDatabase() {
  const documents = new Map();
  let transactionQueue = Promise.resolve();
  const collectionApi = (offset = 0, pageSize = null) => ({
      async get() {
        const rows = [...documents.values()].slice(offset, pageSize === null ? undefined : offset + pageSize);
        return { data: rows.map((document) => structuredClone(document)) };
      },
      limit(value) {
        return collectionApi(offset, value);
      },
      skip(value) {
        return collectionApi(value, pageSize);
      },
      doc(id) {
        return {
          async get() {
            return { data: documents.has(id) ? [structuredClone(documents.get(id))] : [] };
          },
          async set({ data }) {
            documents.set(id, { ...structuredClone(data), _id: id });
          },
          async remove() {
            documents.delete(id);
          },
        };
      },
    });
  return {
    documents,
    collection: collectionApi,
    async createCollection() {},
    async runTransaction(callback) {
      const previous = transactionQueue;
      let release;
      transactionQueue = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback({ collection: collectionApi });
      } finally {
        release();
      }
    },
  };
}

function catalogContract(name, createCatalog) {
  test(`${name}: interval upserts are idempotent`, async (context) => {
    const catalog = await createCatalog(context);
    await catalog.upsertInterval(interval());
    await catalog.upsertInterval({ ...interval(), endMs: 2_500 });
    const rows = await catalog.listIntervals("SN-1", "2026-07-26");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endMs, 2_500);
  });

  test(`${name}: replaceMeals exposes only due pending meals`, async (context) => {
    const catalog = await createCatalog(context);
    await catalog.replaceMeals("SN-1", "2026-07-26", [
      { id: "due", ownerOpenid: "owner-1", deviceSn: "SN-1", date: "2026-07-26", status: "pending", dueAt: 2_000 },
      { id: "later", ownerOpenid: "owner-1", deviceSn: "SN-1", date: "2026-07-26", status: "pending", dueAt: 4_000 },
    ]);
    assert.deepEqual((await catalog.listDueMeals(3_000)).map((meal) => meal.id), ["due"]);
    await catalog.replaceMeals("SN-1", "2026-07-26", [
      { id: "later", ownerOpenid: "owner-1", deviceSn: "SN-1", date: "2026-07-26", status: "pending", dueAt: 4_000 },
    ]);
    assert.deepEqual(await catalog.listDueMeals(3_000), []);
  });

  test(`${name}: only one worker claims a lease and an expired lease is recoverable`, async (context) => {
    const catalog = await createCatalog(context);
    await catalog.putJob(job());
    const claims = await Promise.all([
      catalog.claimJob("j1", "worker-a", 1_000, 60_000),
      catalog.claimJob("j1", "worker-b", 1_000, 60_000),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const firstWorker = claims.find(Boolean).leaseOwner;
    assert.equal(await catalog.claimJob("j1", "worker-c", 60_999, 60_000), null);
    const recovered = await catalog.claimJob("j1", "worker-c", 61_000, 60_000);
    assert.equal(recovered.leaseOwner, "worker-c");
    assert.notEqual(recovered.leaseOwner, firstWorker);
  });

  test(`${name}: material listing is owner/device scoped and hides expired rows`, async (context) => {
    const catalog = await createCatalog(context);
    await catalog.putMaterial(material("visible"));
    await catalog.putMaterial(material("other-owner", { ownerOpenid: "owner-2" }));
    await catalog.putMaterial(material("other-device", { deviceSn: "SN-2" }));
    await catalog.putMaterial(material("expired", { expiresAt: 5_000 }));
    await catalog.putMaterial(material("not-ready", { status: "pending" }));
    const rows = await catalog.listMaterials({
      ownerOpenid: "owner-1",
      deviceSn: "SN-1",
      date: "2026-07-26",
      nowMs: 10_000,
    });
    assert.deepEqual(rows.map((row) => row.id), ["visible"]);
    assert.deepEqual(await catalog.getMaterial("visible"), material("visible"));
  });

  test(`${name}: latest daily swap uses compare-and-swap semantics`, async (context) => {
    const catalog = await createCatalog(context);
    const key = ["owner-1", "SN-1", "2026-07-26"];
    assert.equal(await catalog.swapLatestDaily(...key, null, { materialId: "daily-a", version: "v1" }), true);
    assert.equal(await catalog.swapLatestDaily(...key, null, { materialId: "daily-b", version: "v2" }), false);
    assert.equal(await catalog.swapLatestDaily(...key, "daily-a", { materialId: "daily-b", version: "v2" }), true);
    assert.equal((await catalog.getLatestDaily(...key)).materialId, "daily-b");
  });

  test(`${name}: available foodcast count includes only playable outputs and the current daily version`, async (context) => {
    const catalog = await createCatalog(context);
    await catalog.putMaterial(material("meal-ready"));
    await catalog.putMaterial(material("custom-ready", { kind: "custom" }));
    await catalog.putMaterial(material("daily-old", { kind: "daily" }));
    await catalog.putMaterial(material("daily-current", { kind: "daily" }));
    await catalog.putMaterial(material("daily-segment", { kind: "daily_segment" }));
    await catalog.putMaterial(material("expired", { expiresAt: 5_000 }));
    await catalog.putMaterial(material("pending", { status: "pending" }));
    await catalog.putMaterial(material("missing-file", { fileId: "" }));
    await catalog.putMaterial(material("other-owner", { ownerOpenid: "owner-2" }));
    await catalog.putMaterial(material("other-device", { deviceSn: "SN-2" }));
    await catalog.swapLatestDaily("owner-1", "SN-1", "2026-07-26", null, {
      materialId: "daily-old",
      version: "v1",
    });
    await catalog.swapLatestDaily("owner-1", "SN-1", "2026-07-26", "daily-old", {
      materialId: "daily-current",
      version: "v2",
    });

    assert.equal(await catalog.countAvailableFoodcasts({
      ownerOpenid: "owner-1",
      deviceSn: "SN-1",
      nowMs: 10_000,
    }), 3);
    assert.equal(await catalog.countAvailableFoodcasts({
      ownerOpenid: "owner-2",
      deviceSn: "SN-1",
      nowMs: 10_000,
    }), 1);
  });

  test(`${name}: expired artifacts exclude files referenced by latest daily`, async (context) => {
    const catalog = await createCatalog(context);
    await catalog.putMaterial(material("old", { expiresAt: 5_000 }));
    await catalog.putMaterial(material("latest", { expiresAt: 5_000 }));
    await catalog.putMaterial(material("latest-segment", {
      kind: "daily_segment",
      fileId: "cloud://env/latest.mp4",
      expiresAt: 5_000,
    }));
    await catalog.swapLatestDaily("owner-1", "SN-1", "2026-07-26", null, {
      materialId: "latest",
      version: "v1",
    });
    assert.deepEqual((await catalog.listExpiredArtifacts(10_000)).map((item) => item.id), ["old"]);
    const fileIds = await catalog.expireArtifacts(["old"], 10_000);
    assert.deepEqual(fileIds, ["cloud://env/old.mp4"]);
    assert.equal((await catalog.getMaterial("old")).status, "expired");
  });
}

catalogContract("SQLite catalog", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "foodcast-catalog-"));
  const catalog = new MaterialCatalog(path.join(directory, "catalog.sqlite"));
  context.after(async () => {
    catalog.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return catalog;
});

catalogContract("CloudBase catalog", async () => {
  const catalog = new CloudMaterialCatalog({ database: createFakeDatabase(), collectionName: "materials" });
  await catalog.initialize();
  return catalog;
});

test("CloudBase initialize ignores only the documented already-exists error", async () => {
  const alreadyExists = new CloudMaterialCatalog({
    database: {
      collection: () => ({ get: async () => ({ data: [] }) }),
      createCollection: async () => { throw Object.assign(new Error("exists"), { code: "DATABASE_COLLECTION_ALREADY_EXIST" }); },
    },
  });
  await alreadyExists.initialize();

  const denied = new CloudMaterialCatalog({
    database: {
      collection: () => ({ get: async () => ({ data: [] }) }),
      createCollection: async () => { throw Object.assign(new Error("denied"), { code: "DATABASE_PERMISSION_DENIED" }); },
    },
  });
  await assert.rejects(denied.initialize(), { code: "DATABASE_PERMISSION_DENIED" });
});
