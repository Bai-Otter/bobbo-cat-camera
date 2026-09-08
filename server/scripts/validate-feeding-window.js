#!/usr/bin/env node

const config = require("../src/config");
const routes = require("../src/routes");
const { createDefaultCoordinator } = require("../src/feedAnalysis/coordinator");
const { parseDeviceDateTime } = require("../src/feedAnalysis/deviceTime");

const REQUIRED_WINDOW_SECONDS = 30 * 60;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function sanitizeRecord(record = {}) {
  return {
    beginTime: String(record.BeginTime || record.beginTime || ""),
    endTime: String(record.EndTime || record.endTime || ""),
    fileNamePresent: Boolean(record.FileName || record.fileName),
  };
}

function sanitizeClip(clip = {}) {
  const summary = clip.feedingStats?.summary || {};
  return {
    beginTime: String(clip.beginTime || ""),
    endTime: String(clip.endTime || ""),
    hasCat: clip.hasCat === true,
    hasFeeding: clip.hasFeeding === true,
    mealCount: Number(summary.mealCount) || 0,
    actualEatingSec: Number(summary.actualEatingSeconds ?? summary.actualEatingSec) || 0,
    bowlPresenceSec: Number(summary.bowlPresenceSeconds ?? summary.bowlPresenceSec) || 0,
    markerCount: Array.isArray(clip.markers) ? clip.markers.length : 0,
  };
}

function validateWindow(beginTime, endTime) {
  const begin = parseDeviceDateTime(beginTime);
  const end = parseDeviceDateTime(endTime);
  const durationSec = begin && end ? Math.round((end.getTime() - begin.getTime()) / 1000) : 0;
  if (durationSec !== REQUIRED_WINDOW_SECONDS) throw new Error("VALIDATION_WINDOW_MUST_BE_30_MINUTES");
  return { begin, end, durationSec };
}

async function resolveDevice(coordinator, { deviceSn, deviceName }) {
  const profiles = await coordinator.deviceProvider.listDevices();
  const profile = profiles.find((item) => (
    deviceSn
      ? String(item.sn || "") === deviceSn
      : String(item.nickname || item.name || "") === deviceName
  ));
  if (!profile) throw new Error("VALIDATION_DEVICE_NOT_FOUND");
  const availability = await coordinator.getOnlineTaskDevice({ deviceSn: profile.sn });
  if (!availability.online) throw new Error("VALIDATION_DEVICE_OFFLINE");
  const device = await coordinator.getLoggedInTaskDevice({ deviceSn: profile.sn }, availability.device);
  return { device, profile };
}

async function main() {
  const deviceSn = argumentValue("--device-sn");
  const deviceName = argumentValue("--device-name");
  const beginTime = argumentValue("--begin");
  const endTime = argumentValue("--end");
  const execute = hasArgument("--execute");
  if ((!deviceSn && !deviceName) || !beginTime || !endTime) {
    throw new Error("USAGE: --device-sn <sn>|--device-name <name> --begin <time> --end <time> [--execute]");
  }
  const { begin, end, durationSec } = validateWindow(beginTime, endTime);

  const coordinator = createDefaultCoordinator({ config });
  routes.setFeedAnalysisCoordinator(coordinator);
  await routes.initializeDeviceRegistry();
  await coordinator.initialize();
  const { device, profile } = await resolveDevice(coordinator, { deviceSn, deviceName });
  const recordings = await device.queryRecordings({ beginTime, endTime });
  const recordingKey = `feeding-window:${beginTime}__${endTime}`;
  const before = coordinator.store.getAnalysisRecord?.(profile.sn, recordingKey) || null;
  const output = {
    ok: true,
    execute,
    device: { sn: profile.sn, name: String(profile.nickname || profile.name || "") },
    window: { beginTime, endTime, durationSec },
    playback: {
      mediaType: "hls",
      speed: coordinator.playbackSpeed,
      streamType: coordinator.playbackStreamType,
    },
    recordings: (Array.isArray(recordings) ? recordings : []).map(sanitizeRecord),
    existingResult: before ? sanitizeClip(before.clip) : null,
  };
  if (!execute) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const originalSettings = coordinator.store.getSettings(profile.sn);
  const startedAt = Date.now();
  try {
    await coordinator.persistSettings({
      ...originalSettings,
      deviceSn: profile.sn,
      feedingAnalyzedThroughMs: 0,
      feedingPendingFromMs: begin.getTime(),
      feedingPendingThroughMs: end.getTime(),
    });
    output.result = await coordinator.processAlarmWindowTask({
      device,
      deviceSn: profile.sn,
      alarmWindow: { startMs: begin.getTime(), endMs: end.getTime() },
    });
    output.elapsedMs = Date.now() - startedAt;
    const after = coordinator.store.getAnalysisRecord?.(profile.sn, recordingKey) || null;
    output.persisted = after ? sanitizeClip(after.clip) : null;
    output.reusedExistingResult = Boolean(before && output.result?.analyzed === 0);
  } finally {
    const latestSettings = coordinator.store.getSettings(profile.sn);
    await coordinator.persistSettings({
      ...latestSettings,
      deviceSn: profile.sn,
      feedingAnalyzedThroughMs: Number(originalSettings.feedingAnalyzedThroughMs) || 0,
      feedingPendingFromMs: Number(originalSettings.feedingPendingFromMs) || 0,
      feedingPendingThroughMs: Number(originalSettings.feedingPendingThroughMs) || 0,
    });
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.result?.ok || !output.persisted) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: String(error.code || error.message || "VALIDATION_FAILED"),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  sanitizeClip,
  sanitizeRecord,
  validateWindow,
};
