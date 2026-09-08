const test = require("node:test");
const assert = require("node:assert/strict");

const { ALGORITHM_VERSION, ContinuityV3Selector } = require("./continuitySelector");

function evidenceFrame(offsetSec, cuteScore) {
  return {
    offsetSec,
    hasCat: true,
    cuteEvidence: {
      cuteScore,
      modelConfidence: 0.92,
      sizeScore: cuteScore,
      pitchScore: 0.8,
      visibilityScore: 0.9,
      relationConfidence: 0.9,
      faceRelation: "toward_camera",
    },
  };
}

test("ContinuityV3Selector invokes the frozen annotation-trained selector", async () => {
  const selector = new ContinuityV3Selector({ timeoutMs: 10_000 });
  const frames = Array.from({ length: 20 }, (_, index) => (
    evidenceFrame(index * 0.5, index >= 4 && index <= 12 ? 0.8 : 0.4)
  ));

  const result = await selector.select([{ id: "meal-a", durationSec: 10, frames }]);

  assert.equal(result.algorithm, ALGORITHM_VERSION);
  assert.equal(result.results[0].id, "meal-a");
  assert.ok(result.results[0].segments.length > 0);
  assert.ok(result.results[0].segments.every((segment) => segment.durationSec >= 4));
});

test("ContinuityV3Selector returns immediately for an empty day", async () => {
  const selector = new ContinuityV3Selector();
  const result = await selector.select([]);

  assert.deepEqual(result, { ok: true, algorithm: ALGORITHM_VERSION, config: {}, results: [] });
});
