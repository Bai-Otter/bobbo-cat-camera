const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addMaterial,
  buildCustomRequest,
  canExport,
  emptyState,
  reorderMaterial,
  selectedDuration,
  trimMaterial,
} = require("./foodcastEditor.js");

function material(id, durationSec) {
  return { id, durationSec, kind: "meal", previewUrl: `https://media.test/${id}.mp4` };
}

test("reorders, trims, and builds the exact custom request", () => {
  let state = addMaterial(emptyState(), material("a", 50));
  state = addMaterial(state, material("b", 40));
  state = reorderMaterial(state, 1, 0);
  state = trimMaterial(state, "b", 2, 20.5);
  assert.deepEqual(buildCustomRequest(state, {
    deviceSn: "SN", bgmId: "bgm-01", bgmVolume: 0.7,
  }), {
    deviceSn: "SN", frameMode: "source", bgmId: "bgm-01", bgmVolume: 0.7,
    segments: [
      { materialId: "b", trimStartSec: 2, trimEndSec: 20.5 },
      { materialId: "a", trimStartSec: 0, trimEndSec: 50 },
    ],
  });
});

test("duplicate adds are ignored and selection is capped at ten materials", () => {
  let state = addMaterial(emptyState(), material("a", 10));
  assert.equal(addMaterial(state, material("a", 10)), state);
  for (let index = 0; index < 9; index += 1) state = addMaterial(state, material(`m${index}`, 10));
  assert.equal(state.selected.length, 10);
  assert.equal(addMaterial(state, material("overflow", 10)), state);
});

test("trims snap to half seconds and export enforces five minute total", () => {
  let state = addMaterial(emptyState(), material("a", 400));
  state = trimMaterial(state, "a", 1.24, 301.26);
  assert.equal(state.selected[0].trimStartSec, 1);
  assert.equal(state.selected[0].trimEndSec, 301.5);
  assert.equal(selectedDuration(state), 300.5);
  assert.equal(canExport(state, { bgmId: "bgm-01" }), false);
  state = trimMaterial(state, "a", 1, 301);
  assert.equal(canExport(state, { bgmId: "bgm-01" }), true);
  assert.equal(canExport(state, { bgmId: "" }), false);
});
