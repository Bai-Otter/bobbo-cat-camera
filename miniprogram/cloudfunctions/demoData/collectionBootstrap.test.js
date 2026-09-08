const test = require("node:test");
const assert = require("node:assert/strict");

const { isCollectionMissing, withCollection } = require("./collectionBootstrap");

test("isCollectionMissing recognizes the CloudBase missing collection response", () => {
  const error = new Error("collection.get:fail -502005 database collection not exists");
  error.code = -502005;
  assert.equal(isCollectionMissing(error), true);
  assert.equal(isCollectionMissing(new Error("NETWORK_ERROR")), false);
});

test("withCollection creates a missing collection and retries once", async () => {
  const calls = [];
  let attempts = 0;
  const database = {
    async createCollection(name) {
      calls.push(["createCollection", name]);
    },
  };

  const result = await withCollection(database, "device_covers", async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("Db or Table not exist: device_covers");
      error.errCode = -502005;
      throw error;
    }
    return { ok: true };
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [["createCollection", "device_covers"]]);
  assert.equal(attempts, 2);
});

test("withCollection tolerates another request creating the collection first", async () => {
  let attempts = 0;
  const database = {
    async createCollection() {
      const error = new Error("collection already exists");
      error.code = "DATABASE_COLLECTION_ALREADY_EXIST";
      throw error;
    },
  };

  const result = await withCollection(database, "device_covers", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("-502005 database collection not exists");
    return "saved";
  });

  assert.equal(result, "saved");
});
