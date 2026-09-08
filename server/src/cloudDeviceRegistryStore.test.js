const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CloudDeviceRegistryStore,
  buildCloudbaseInitOptions,
  deviceDocumentId,
} = require("./cloudDeviceRegistryStore");

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
            async set(document) {
              documents.set(id, { ...document, _id: id });
              return { updated: 1 };
            },
          };
        },
      };
    },
  };
}

test("CloudBase store uses deterministic IDs and preserves owner state", async () => {
  const database = createFakeDatabase();
  const store = new CloudDeviceRegistryStore({ database });
  const state = {
    version: 2,
    activeByOwner: { "openid-owner": "CAM-A" },
    devices: [{ sn: "CAM-A", ownerOpenid: "openid-owner", username: "admin" }],
  };

  await store.save(state);

  assert.ok(database.documents.has(deviceDocumentId("CAM-A")));
  assert.equal(database.documents.get(deviceDocumentId("CAM-A")).sn, "CAM-A");
  assert.equal(database.documents.get(deviceDocumentId("CAM-A")).data, undefined);
  assert.deepEqual((await store.load()).activeByOwner, { "openid-owner": "CAM-A" });
});

test("CloudBase store reads legacy profiles nested under data", async () => {
  const database = createFakeDatabase();
  database.documents.set(deviceDocumentId("CAM-LEGACY"), {
    _id: deviceDocumentId("CAM-LEGACY"),
    data: {
      sn: "CAM-LEGACY",
      ownerOpenid: "legacy-owner",
      username: "admin",
      active: true,
    },
  });
  const store = new CloudDeviceRegistryStore({ database });

  const state = await store.load();

  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].sn, "CAM-LEGACY");
  assert.deepEqual(state.activeByOwner, { "legacy-owner": "CAM-LEGACY" });
});

test("CloudBase store enforces ownership on legacy nested profiles", async () => {
  const database = createFakeDatabase();
  database.documents.set(deviceDocumentId("CAM-LEGACY"), {
    _id: deviceDocumentId("CAM-LEGACY"),
    data: { sn: "CAM-LEGACY", ownerOpenid: "owner" },
  });
  const store = new CloudDeviceRegistryStore({ database });

  await assert.rejects(store.save({
    version: 2,
    activeByOwner: { attacker: "CAM-LEGACY" },
    devices: [{ sn: "CAM-LEGACY", ownerOpenid: "attacker" }],
  }), /DEVICE_ALREADY_OWNED/);
});

test("CloudBase store refuses to overwrite another owner's serial number", async () => {
  const database = createFakeDatabase();
  const store = new CloudDeviceRegistryStore({ database });
  await store.save({
    version: 2,
    activeByOwner: { owner: "CAM-A" },
    devices: [{ sn: "CAM-A", ownerOpenid: "owner" }],
  });

  await assert.rejects(store.save({
    version: 2,
    activeByOwner: { attacker: "CAM-A" },
    devices: [{ sn: "CAM-A", ownerOpenid: "attacker" }],
  }), /DEVICE_ALREADY_OWNED/);
});

test("CloudBase initialization includes explicit server credentials", () => {
  assert.deepEqual(buildCloudbaseInitOptions({
    envId: "env-test",
    secretId: "secret-id-test",
    secretKey: "secret-key-test",
  }), {
    env: "env-test",
    secretId: "secret-id-test",
    secretKey: "secret-key-test",
  });
});

test("CloudBase store persists sharing metadata separately from device credentials", async () => {
  const database = createFakeDatabase();
  const store = new CloudDeviceRegistryStore({ database });
  await store.save({
    version: 3,
    activeByOwner: { owner: "CAM-A", member: "CAM-A" },
    devices: [{ sn: "CAM-A", ownerOpenid: "owner" }],
    membersBySn: { "CAM-A": [{ openid: "member", joinedAt: 123 }] },
    shareInvites: [{ id: "invite-1", deviceSn: "CAM-A", tokenHash: "hash" }],
  });

  const loaded = await store.load();
  assert.deepEqual(loaded.membersBySn, { "CAM-A": [{ openid: "member", joinedAt: 123 }] });
  assert.equal(loaded.shareInvites[0].id, "invite-1");
  assert.equal(loaded.devices.length, 1);
});
