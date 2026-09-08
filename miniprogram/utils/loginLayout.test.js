const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getSafeViewportHeight,
  resolveLoginLayoutTier,
} = require("./loginLayout.js");

test("getSafeViewportHeight prefers safeArea height when present", () => {
  assert.equal(
    getSafeViewportHeight({
      windowHeight: 820,
      safeArea: { top: 32, bottom: 792 },
    }),
    760
  );
});

test("getSafeViewportHeight falls back to windowHeight", () => {
  assert.equal(getSafeViewportHeight({ windowHeight: 812 }), 812);
});

test("resolveLoginLayoutTier returns compact at or below 760px", () => {
  assert.equal(resolveLoginLayoutTier(760), "compact");
  assert.equal(resolveLoginLayoutTier(720), "compact");
});

test("resolveLoginLayoutTier returns regular between 761px and 860px", () => {
  assert.equal(resolveLoginLayoutTier(761), "regular");
  assert.equal(resolveLoginLayoutTier(860), "regular");
});

test("resolveLoginLayoutTier returns roomy above 860px", () => {
  assert.equal(resolveLoginLayoutTier(861), "roomy");
});
