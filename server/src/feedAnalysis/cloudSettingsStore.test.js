const test = require("node:test");
const assert = require("node:assert/strict");

const { CloudFeedAnalysisSettingsStore } = require("./cloudSettingsStore");

function fakeDatabase(seed = []) {
  const collections = new Map();
  collections.set("feed_analysis_states", seed.map((item, index) => ({ _id: `row-${index}`, ...item })));
  return {
    get rows() { return collections.get("feed_analysis_states"); },
    collections,
    async createCollection(name) {
      if (!collections.has(name)) collections.set(name, []);
    },
    collection(name) {
      if (!collections.has(name)) collections.set(name, []);
      const rows = collections.get(name);
      return {
        async get() { return { data: rows.map((item) => ({ ...item })) }; },
        where(query) {
          return {
            limit() {
              return { async get() { return { data: rows.filter((item) => item.deviceSn === query.deviceSn).slice(0, 1) }; } };
            },
          };
        },
        doc(id) {
          return {
            async set(document) {
              const index = rows.findIndex((item) => item._id === id);
              rows[index] = { _id: id, ...document };
            },
          };
        },
        async add(document) { rows.push({ _id: `row-${rows.length}`, ...document }); },
      };
    },
  };
}

test("CloudFeedAnalysisSettingsStore restores and updates durable device settings", async () => {
  const database = fakeDatabase([{ deviceSn: "CAM-A", openid: "owner-a", analysisEnabled: true, notifyEnabled: true }]);
  const store = new CloudFeedAnalysisSettingsStore({ database });

  assert.deepEqual(await store.loadAll(), [{ deviceSn: "CAM-A", openid: "owner-a", analysisEnabled: true, notifyEnabled: true }]);
  await store.upsert({ deviceSn: "CAM-A", openid: "owner-a", analysisEnabled: false, notifyEnabled: false });

  assert.equal(database.rows.length, 1);
  assert.equal(database.rows[0].analysisEnabled, false);
  assert.equal(database.rows[0].data, undefined);
});

test("CloudFeedAnalysisSettingsStore restores and canonicalizes legacy nested settings", async () => {
  const database = fakeDatabase([{ data: {
    deviceSn: "CAM-LEGACY", openid: "owner-a", analysisEnabled: true, notifyEnabled: true,
  } }]);
  const store = new CloudFeedAnalysisSettingsStore({ database });

  assert.deepEqual(await store.loadAll(), [{
    deviceSn: "CAM-LEGACY", openid: "owner-a", analysisEnabled: true, notifyEnabled: true,
  }]);
  await store.upsert({ deviceSn: "CAM-LEGACY", openid: "owner-a", analysisEnabled: true, notifyEnabled: false });

  assert.equal(database.rows.length, 1);
  assert.equal(database.rows[0].deviceSn, "CAM-LEGACY");
  assert.equal(database.rows[0].notifyEnabled, false);
  assert.equal(database.rows[0].data, undefined);
});

test("CloudFeedAnalysisSettingsStore restores and updates durable PushPlus bindings", async () => {
  const database = fakeDatabase();
  database.collections.set("pushplus_bindings", [{
    _id: "binding-0",
    openid: "owner-a",
    friendToken: "token-old",
    isFollow: true,
  }]);
  const store = new CloudFeedAnalysisSettingsStore({ database });

  assert.deepEqual(await store.loadBindings(), [{
    openid: "owner-a",
    friendToken: "token-old",
    isFollow: true,
  }]);
  await store.upsertBinding({ openid: "owner-a", friendToken: "token-new", isFollow: true });

  assert.equal(database.collections.get("pushplus_bindings").length, 1);
  assert.equal(database.collections.get("pushplus_bindings")[0].friendToken, "token-new");
});
