const test = require("node:test");
const assert = require("node:assert/strict");

const { CloudLiveRecordingStore, recordingDocumentId } = require("./cloudLiveRecordingStore");
const { exerciseContract } = require("./liveRecordingStore.contract");

function createFakeDatabase() {
  const documents = new Map();
  return {
    documents,
    collection() {
      return {
        async get() {
          return { data: [...documents.values()].map((item) => ({ ...item })) };
        },
        doc(id) {
          return {
            async get() {
              return { data: documents.has(id) ? [{ ...documents.get(id) }] : [] };
            },
            async set(data) {
              documents.set(id, { ...data, _id: id });
              return { updated: 1 };
            },
          };
        },
      };
    },
  };
}

test("CloudBase recording store satisfies the shared contract with deterministic document IDs", async () => {
  const database = createFakeDatabase();
  const store = new CloudLiveRecordingStore({ database });

  await exerciseContract(store);

  assert.ok(database.documents.has(recordingDocumentId("record-1")));
  assert.equal(database.documents.get(recordingDocumentId("record-1")).ownerOpenid, "openid-owner");
});

test("CloudBase recording store requires a database", () => {
  assert.throws(() => new CloudLiveRecordingStore(), /CLOUDBASE_DATABASE_REQUIRED/);
});

test("CloudBase recording store preserves timestamps from legacy nested recording documents", async () => {
  const database = createFakeDatabase();
  const store = new CloudLiveRecordingStore({ database });
  const id = recordingDocumentId("record-legacy");
  database.documents.set(id, {
    _id: id,
    data: {
      id: "record-legacy",
      ownerOpenid: "owner",
      deviceSn: "SN-1",
      status: "recording",
      accessToken: "token",
      startedAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 2_000,
    },
  });

  const updated = await store.updateJob("record-legacy", {
    status: "finalizing",
    endedAt: 12_000,
    updatedAt: 12_000,
  });

  assert.equal(updated.startedAt, 1_000);
  assert.equal(updated.endedAt, 12_000);
});

test("CloudBase recording store creates its collection and tolerates an existing collection", async () => {
  const created = [];
  const database = createFakeDatabase();
  database.createCollection = async (name) => {
    created.push(name);
    if (created.length === 2) {
      throw Object.assign(new Error("exists"), { code: "DATABASE_COLLECTION_ALREADY_EXIST" });
    }
  };
  const store = new CloudLiveRecordingStore({
    database,
    collectionName: "live-recordings-test",
  });

  await store.initialize();
  await store.initialize();

  assert.deepEqual(created, ["live-recordings-test", "live-recordings-test"]);
});
