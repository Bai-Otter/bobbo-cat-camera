const assert = require("node:assert/strict");
const test = require("node:test");
const { sanitizeTimeline } = require("./foodcastAlgorithmTestService");

test("foodcast algorithm timeline preserves cute state evidence and strips unrelated fields", () => {
  const timeline = sanitizeTimeline({
    bowlRoi: { x: 1, y: 2, width: 3, height: 4 },
    frames: [{
      second: 4,
      offsetSec: 4.5,
      hasCat: true,
      cuteEvidence: { front: true, cuteReasons: ["head_up"] },
      catBoxes: [{ x: 1, y: 2, width: 3, height: 4 }],
      secretToken: "must-not-escape",
    }],
  });
  assert.deepEqual(timeline[0].cuteEvidence, { front: true, cuteReasons: ["head_up"] });
  assert.deepEqual(timeline[0].bowlRoi, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal("secretToken" in timeline[0], false);
});
