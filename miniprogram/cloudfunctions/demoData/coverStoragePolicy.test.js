const test = require("node:test");
const assert = require("node:assert/strict");

const { getObsoleteCoverFileId } = require("./coverStoragePolicy");

test("getObsoleteCoverFileId only returns a replaced cloud file", () => {
  assert.equal(
    getObsoleteCoverFileId(
      { fileId: "cloud://demo/device-covers/SN001/old.jpg" },
      "cloud://demo/device-covers/SN001/latest.jpg"
    ),
    "cloud://demo/device-covers/SN001/old.jpg"
  );
  assert.equal(
    getObsoleteCoverFileId(
      { fileId: "cloud://demo/device-covers/SN001/latest.jpg" },
      "cloud://demo/device-covers/SN001/latest.jpg"
    ),
    ""
  );
  assert.equal(getObsoleteCoverFileId(null, "cloud://demo/latest.jpg"), "");
});
