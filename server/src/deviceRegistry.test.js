const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeviceRegistry } = require("./deviceRegistry");

function tempRegistryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-device-registry-"));
  return path.join(dir, "devices.json");
}

test("legacy file registry migrates every device to the configured owner", async () => {
  const filePath = tempRegistryFile();
  fs.writeFileSync(filePath, JSON.stringify({
    activeSn: "CAM-B",
    devices: [
      { sn: "CAM-A", username: "admin", password: "a" },
      { sn: "CAM-B", username: "admin", password: "b" },
    ],
  }));
  const registry = new DeviceRegistry({
    filePath,
    legacyOwnerOpenid: "openid-owner",
    requireLegacyOwner: true,
  });

  await registry.initialize();

  assert.deepEqual((await registry.listForOwner("openid-owner")).map((item) => item.sn), ["CAM-B", "CAM-A"]);
  assert.equal(await registry.getActiveSnForOwner("openid-owner"), "CAM-B");
  assert.equal(await registry.getForOwner("CAM-A", "openid-other"), null);

  const restarted = new DeviceRegistry({ filePath, legacyOwnerOpenid: "openid-owner", requireLegacyOwner: true });
  await restarted.initialize();
  assert.equal((await restarted.getForOwner("CAM-B", "openid-owner")).password, "b");
});

test("explicit legacy owner migrates a local placeholder device and active mapping", async () => {
  const filePath = tempRegistryFile();
  fs.writeFileSync(filePath, JSON.stringify({
    version: 2,
    activeSn: "CAM-A",
    activeByOwner: { __legacy_local__: "CAM-A" },
    devices: [
      { sn: "CAM-A", ownerOpenid: "__legacy_local__", username: "admin" },
    ],
  }));
  const registry = new DeviceRegistry({
    filePath,
    legacyOwnerOpenid: "openid-owner",
  });

  await registry.initialize();

  assert.equal((await registry.getForOwner("CAM-A", "openid-owner")).sn, "CAM-A");
  assert.equal(await registry.getActiveSnForOwner("openid-owner"), "CAM-A");
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(Object.hasOwn(persisted.activeByOwner, "__legacy_local__"), false);
});

test("owner-aware registry isolates users and rejects device takeover", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();

  await registry.upsertForOwner({ sn: "OWNER-CAM", username: "admin" }, "openid-owner", { active: true });
  await registry.upsertForOwner({ sn: "OTHER-CAM", username: "admin" }, "openid-other", { active: true });

  assert.deepEqual((await registry.listForOwner("openid-owner")).map((item) => item.sn), ["OWNER-CAM"]);
  assert.equal(await registry.getForOwner("OTHER-CAM", "openid-owner"), null);
  await assert.rejects(
    registry.upsertForOwner({ sn: "OWNER-CAM" }, "openid-other"),
    /DEVICE_ALREADY_OWNED/
  );
});

test("owner rename persists without changing credentials and is visible to shared members", async () => {
  const filePath = tempRegistryFile();
  const registry = new DeviceRegistry({ filePath });
  await registry.initialize();
  await registry.upsertForOwner({
    sn: "OWNER-CAM",
    nickname: "Old name",
    username: "admin",
    password: "camera-secret",
    ip: "192.168.1.9",
    port: "8000",
  }, "openid-owner", { active: true });
  await registry.createShareInvite("OWNER-CAM", "openid-owner", {
    tokenHash: "rename-share",
    expiresAt: 5000,
    now: 1000,
  });
  await registry.redeemShareInvite("rename-share", "openid-member", { now: 1100 });

  const renamed = await registry.renameForOwner("OWNER-CAM", "openid-owner", "  餐桌摄像头  ");

  assert.equal(renamed.nickname, "餐桌摄像头");
  assert.equal(renamed.password, "camera-secret");
  assert.equal(renamed.ip, "192.168.1.9");
  assert.equal(renamed.port, "8000");
  assert.equal((await registry.listAccessible("openid-member"))[0].nickname, "餐桌摄像头");
  assert.equal(await registry.renameForOwner("OWNER-CAM", "openid-member", "Member alias"), null);
  await assert.rejects(registry.renameForOwner("OWNER-CAM", "openid-owner", "   "), /DEVICE_NICKNAME_REQUIRED/);
  await assert.rejects(registry.renameForOwner("OWNER-CAM", "openid-owner", "x".repeat(81)), /DEVICE_NICKNAME_TOO_LONG/);

  const restarted = new DeviceRegistry({ filePath });
  await restarted.initialize();
  assert.equal((await restarted.getForOwner("OWNER-CAM", "openid-owner")).nickname, "餐桌摄像头");
  assert.equal((await restarted.listMembers("OWNER-CAM", "openid-owner")).length, 1);
  assert.equal(await restarted.getActiveSnForOwner("openid-owner"), "OWNER-CAM");
});

test("owner-aware removal falls back to the owner's remaining active device", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "OWNER-A" }, "openid-owner", { active: true });
  await registry.upsertForOwner({ sn: "OWNER-B" }, "openid-owner", { active: true });
  await registry.upsertForOwner({ sn: "OTHER-A" }, "openid-other", { active: true });

  assert.equal(await registry.removeForOwner("OWNER-B", "openid-other"), null);
  const removed = await registry.removeForOwner("OWNER-B", "openid-owner");

  assert.equal(removed.sn, "OWNER-B");
  assert.deepEqual((await registry.listForOwner("openid-owner")).map((item) => item.sn), ["OWNER-A"]);
  assert.equal(await registry.getActiveSnForOwner("openid-owner"), "OWNER-A");
  assert.deepEqual((await registry.listForOwner("openid-other")).map((item) => item.sn), ["OTHER-A"]);
});

test("a removed environment-seeded device stays removed after restart", async () => {
  const filePath = tempRegistryFile();
  const options = {
    filePath,
    legacyOwnerOpenid: "openid-owner",
    defaultProfile: { sn: "LEGACY-CAM", nickname: "Legacy camera" },
  };
  const registry = new DeviceRegistry(options);
  await registry.initialize();
  assert.equal((await registry.listForOwner("openid-owner"))[0].sn, "LEGACY-CAM");

  await registry.removeForOwner("LEGACY-CAM", "openid-owner");
  const restarted = new DeviceRegistry(options);
  await restarted.initialize();

  assert.deepEqual(await restarted.listForOwner("openid-owner"), []);
  assert.equal(await restarted.getActiveSnForOwner("openid-owner"), "");
});

test("production migration fails closed when legacy devices have no owner", async () => {
  const filePath = tempRegistryFile();
  fs.writeFileSync(filePath, JSON.stringify({ activeSn: "CAM-A", devices: [{ sn: "CAM-A" }] }));
  const registry = new DeviceRegistry({ filePath, requireLegacyOwner: true });

  await assert.rejects(registry.initialize(), /LEGACY_DEVICE_OWNER_REQUIRED/);
});

test("owner creates a single-use invite and a member gains device access", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "CAM-A", nickname: "Bowl camera" }, "owner", { active: true });

  const invite = await registry.createShareInvite("CAM-A", "owner", {
    tokenHash: "hash-1",
    expiresAt: 2000,
    now: 1000,
  });
  const access = await registry.redeemShareInvite("hash-1", "member", { now: 1500 });

  assert.equal(invite.deviceSn, "CAM-A");
  assert.equal(access.role, "member");
  assert.equal((await registry.getAccessible("CAM-A", "member")).role, "member");
  assert.equal((await registry.listAccessible("member"))[0].role, "member");
  const repeated = await registry.redeemShareInvite("hash-1", "member", { now: 1550 });
  assert.equal(repeated.role, "member");
  assert.equal((await registry.listMembers("CAM-A", "owner")).length, 1);
  await assert.rejects(
    registry.redeemShareInvite("hash-1", "other", { now: 1600 }),
    /SHARE_INVITE_USED/
  );

  await registry.revokeMember("CAM-A", "owner", "member");
  await assert.rejects(
    registry.redeemShareInvite("hash-1", "member", { now: 1700 }),
    /SHARE_INVITE_USED/
  );
});

test("share invites expire and each device accepts at most five members", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile(), maxMembersPerDevice: 5 });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "CAM-A" }, "owner", { active: true });
  await registry.createShareInvite("CAM-A", "owner", {
    tokenHash: "expired",
    expiresAt: 1000,
    now: 500,
  });
  await assert.rejects(
    registry.redeemShareInvite("expired", "late", { now: 1001 }),
    /SHARE_INVITE_EXPIRED/
  );

  for (let index = 0; index < 5; index += 1) {
    const tokenHash = `hash-${index}`;
    await registry.createShareInvite("CAM-A", "owner", { tokenHash, expiresAt: 5000, now: 1000 + index });
    await registry.redeemShareInvite(tokenHash, `member-${index}`, { now: 2000 + index });
  }
  await registry.createShareInvite("CAM-A", "owner", { tokenHash: "overflow", expiresAt: 5000, now: 3000 });
  await assert.rejects(
    registry.redeemShareInvite("overflow", "member-6", { now: 3001 }),
    /DEVICE_MEMBER_LIMIT_REACHED/
  );
});

test("owner revocation and member exit remove shared access without removing the device", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "CAM-A" }, "owner", { active: true });
  for (const [tokenHash, openid] of [["hash-a", "member-a"], ["hash-b", "member-b"]]) {
    await registry.createShareInvite("CAM-A", "owner", { tokenHash, expiresAt: 5000, now: 1000 });
    await registry.redeemShareInvite(tokenHash, openid, { now: 1100 });
  }

  assert.equal((await registry.revokeMember("CAM-A", "owner", "member-a")).openid, "member-a");
  assert.equal(await registry.getAccessible("CAM-A", "member-a"), null);
  assert.equal((await registry.leaveSharedDevice("CAM-A", "member-b")).openid, "member-b");
  assert.equal(await registry.getAccessible("CAM-A", "member-b"), null);
  assert.equal((await registry.getForOwner("CAM-A", "owner")).sn, "CAM-A");
});

test("owner manages cat profiles while shared members receive read-only assigned cats", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "CAM-A" }, "owner", { active: true });
  await registry.upsertForOwner({ sn: "CAM-B" }, "owner", { active: false });
  await registry.upsertCatForOwner("owner", {
    id: "xiaobu",
    name: "小布",
    avatar: "cloud://cats/xiaobu.jpg",
    health: "过敏",
  });
  await registry.upsertCatForOwner("owner", { id: "guagua", name: "瓜瓜" });
  await registry.assignPrimaryCat("CAM-A", "owner", "xiaobu");
  await registry.createShareInvite("CAM-A", "owner", { tokenHash: "cat-share", expiresAt: 5000, now: 1000 });
  await registry.redeemShareInvite("cat-share", "member", { now: 1100 });

  assert.deepEqual((await registry.listCatsForUser("member")).map((cat) => cat.id), ["xiaobu"]);
  assert.equal((await registry.listCatsForUser("member"))[0].readOnly, true);
  assert.deepEqual(new Set((await registry.listCatsForUser("owner")).map((cat) => cat.id)), new Set(["xiaobu", "guagua"]));
  assert.equal((await registry.getAccessible("CAM-A", "member")).primaryCatId, "xiaobu");
  await registry.upsertCatForOwner("member", { id: "member-cat", name: "自己的猫" });
  assert.deepEqual((await registry.listCatsForUser("member")).map((cat) => [cat.name, cat.source, cat.readOnly]), [
    ["自己的猫", "owned", false],
    ["小布", "shared", true],
  ]);

  await registry.deleteCatForOwner("owner", "xiaobu");
  assert.equal((await registry.getForOwner("CAM-A", "owner")).primaryCatId, "");
});

test("shared devices fall back to the owner's first cat when no primary cat is assigned", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "CAM-A" }, "owner", { active: true });
  await registry.upsertCatForOwner("owner", { id: "first-cat", name: "第一只猫" });
  await registry.createShareInvite("CAM-A", "owner", { tokenHash: "fallback-share", expiresAt: 5000, now: 1000 });
  await registry.redeemShareInvite("fallback-share", "member", { now: 1100 });

  const device = (await registry.listAccessible("member"))[0];
  const cats = await registry.listCatsForUser("member");
  assert.equal(device.primaryCatId, "first-cat");
  assert.equal(cats.length, 1);
  assert.equal(cats[0].id, "first-cat");
  assert.equal(cats[0].readOnly, true);
});

test("a mixed account keeps its own cats and receives shared primary cats without id collisions", async () => {
  const registry = new DeviceRegistry({ filePath: tempRegistryFile() });
  await registry.initialize();
  await registry.upsertForOwner({ sn: "OWN-CAM" }, "member", { active: true });
  await registry.upsertForOwner({ sn: "SHARED-CAM", primaryCatId: "same-id" }, "owner", { active: false });
  await registry.upsertCatForOwner("member", { id: "same-id", name: "自己的猫" });
  await registry.upsertCatForOwner("owner", { id: "same-id", name: "共享猫" });
  await registry.createShareInvite("SHARED-CAM", "owner", {
    tokenHash: "mixed-share",
    expiresAt: 5000,
    now: 1000,
  });
  await registry.redeemShareInvite("mixed-share", "member", { now: 1100 });

  const cats = await registry.listCatsForUser("member");
  assert.deepEqual(cats.map((cat) => [cat.name, cat.source, cat.readOnly]), [
    ["自己的猫", "owned", false],
    ["共享猫", "shared", true],
  ]);
  assert.notEqual(cats[0].catRef, cats[1].catRef);
  assert.deepEqual(cats[1].sourceDeviceSns, ["SHARED-CAM"]);
  assert.equal((await registry.listAccessible("member")).find((item) => item.sn === "SHARED-CAM").primaryCatRef, cats[1].catRef);
});
