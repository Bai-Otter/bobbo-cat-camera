function emptyState() {
  return { frameMode: "source", selected: [] };
}

function normalizeMaterial(material = {}) {
  const id = String(material.id || "").trim();
  const durationSec = Number(material.durationSec);
  if (!id || !Number.isFinite(durationSec) || durationSec < 0.5) return null;
  return {
    id,
    kind: material.kind || "meal",
    date: material.date || "",
    durationSec,
    previewUrl: material.previewUrl || "",
    coverUrl: material.coverUrl || "",
    trimStartSec: 0,
    trimEndSec: durationSec,
  };
}

function addMaterial(state, material) {
  const normalized = normalizeMaterial(material);
  if (!normalized || state.selected.some((item) => item.id === normalized.id) || state.selected.length >= 10) {
    return state;
  }
  return { ...state, selected: [...state.selected, normalized] };
}

function removeMaterial(state, materialId) {
  if (!state.selected.some((item) => item.id === materialId)) return state;
  return { ...state, selected: state.selected.filter((item) => item.id !== materialId) };
}

function reorderMaterial(state, fromIndex, toIndex) {
  const from = Number(fromIndex);
  const target = Math.max(0, Math.min(state.selected.length - 1, Number(toIndex)));
  if (!Number.isInteger(from) || !Number.isInteger(target)
    || from < 0 || from >= state.selected.length || from === target) return state;
  const selected = state.selected.slice();
  const [item] = selected.splice(from, 1);
  selected.splice(target, 0, item);
  return { ...state, selected };
}

function snapHalf(value) {
  return Math.round(Number(value) * 2) / 2;
}

function trimMaterial(state, materialId, trimStartSec, trimEndSec) {
  const index = state.selected.findIndex((item) => item.id === materialId);
  if (index < 0) return state;
  const item = state.selected[index];
  const start = Math.max(0, snapHalf(trimStartSec));
  const end = Math.min(item.durationSec, snapHalf(trimEndSec));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.5) return state;
  const selected = state.selected.slice();
  selected[index] = { ...item, trimStartSec: start, trimEndSec: end };
  return { ...state, selected };
}

function selectedDuration(state) {
  return Math.round(state.selected.reduce((sum, item) => (
    sum + Math.max(0, Number(item.trimEndSec) - Number(item.trimStartSec))
  ), 0) * 2) / 2;
}

function canExport(state, { bgmId } = {}) {
  const musicId = String(bgmId || "").trim().toLowerCase();
  const duration = selectedDuration(state);
  return state.selected.length > 0
    && state.selected.length <= 10
    && duration > 0
    && duration <= 300
    && musicId !== ""
    && musicId !== "none"
    && musicId !== "random";
}

function buildCustomRequest(state, { deviceSn, bgmId, bgmVolume } = {}) {
  if (!canExport(state, { bgmId })) {
    const error = new Error("CUSTOM_COMPOSITION_INVALID");
    error.code = "CUSTOM_COMPOSITION_INVALID";
    throw error;
  }
  return {
    deviceSn: String(deviceSn || ""),
    frameMode: state.frameMode === "center_crop" ? "center_crop" : "source",
    bgmId: String(bgmId),
    bgmVolume: Math.max(0.2, Math.min(1, Number(bgmVolume) || 0.2)),
    segments: state.selected.map((item) => ({
      materialId: item.id,
      trimStartSec: item.trimStartSec,
      trimEndSec: item.trimEndSec,
    })),
  };
}

module.exports = {
  addMaterial,
  buildCustomRequest,
  canExport,
  emptyState,
  normalizeMaterial,
  removeMaterial,
  reorderMaterial,
  selectedDuration,
  trimMaterial,
};
