const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AccountSyncAudit, cleanRequestId, safeErrorCode } = require("./accountSyncAudit");

test("account sync audit persists hashes and safe error codes without credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-sync-audit-"));
  const filePath = path.join(dir, "sync.jsonl");
  const audit = new AccountSyncAudit({
    filePath,
    now: () => "2026-08-13T05:00:00.000Z",
    logger: { info() {}, warn() {} },
  });
  const entry = audit.record("device_bind_failed", {
    requestId: "bind_20260813_12345678",
    resourceId: "SECRET-SN-001",
    openid: "private-openid",
    source: "ble-pairing",
    error: new Error('设备绑定失败: {"code":29013,"data":"private-token"}'),
  });

  const persisted = fs.readFileSync(filePath, "utf8");
  assert.equal(entry.errorCode, "29013");
  assert.doesNotMatch(persisted, /SECRET-SN-001|private-openid|private-token/);
  assert.match(persisted, /"resourceHash":"[a-f0-9]{16}"/);
});

test("account sync audit normalizes request ids and named errors", () => {
  assert.equal(cleanRequestId("bind_12345678"), "bind_12345678");
  assert.notEqual(cleanRequestId("bad id"), "bad id");
  assert.equal(safeErrorCode(new Error("CAT_PROFILE_READ_ONLY")), "CAT_PROFILE_READ_ONLY");
});
