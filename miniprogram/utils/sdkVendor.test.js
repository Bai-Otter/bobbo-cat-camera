const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("miniprogram packages the JLink wx SDK required by main.js", () => {
  const sdkPath = path.join(__dirname, "../jlink-wx-sdk/dist/jlink-wx-sdk.js");

  assert.equal(fs.existsSync(sdkPath), true);
});
